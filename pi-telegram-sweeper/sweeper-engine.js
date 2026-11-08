'use strict';

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(10, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
const MIN_THRESHOLD = Number(process.env.SWEEP_MIN_THRESHOLD || 0.002);
const DATA_DIR = process.env.DATA_DIR || '/data';

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const walletLocks = new Set();
let monitorRunning = false;
let monitorTimeoutId = null;

// IN-MEMORY STORAGE (RAM) - Keys are never saved to disk
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
  const Database = require('better-sqlite3');
  const db = new Database(path.join(DATA_DIR, 'sweeper.db'));
  db.pragma('journal_mode = WAL');
  
  db.exec(`
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
  return db;
}

const WalletManager = {
  addLiveWallet({ id, publicKey, secretKey, label, chatId }) {
    liveWalletsMap.set(String(id), { id, publicKey, secretKey, label, chatId });
    log('INFO', `Wallet Box #${id} loaded successfully into volatile system memory.`);
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
    log('ERROR', 'Telegram notification dispatch failed', error.message);
  }
}

const SweeperEngine = {
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
      if (!DESTINATION) throw new Error('SWEEP_DESTINATION_ADDRESS configuration is empty.');
      const evalResult = await this.evaluateBalance(wallet.public_key);

      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      log('INFO', `Wallet Box #${id} matches eligible threshold: ${evalResult.spendable} Pi.`);

      await notifyTelegram(bot, wallet.chat_id, `🔍 <b>SWEEP DETECTED IN RAM!</b>\nBox: #${wallet.id}\nAvailable: <code>${evalResult.spendable.toFixed(7)} Pi</code>`);

      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret_key);
      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      const trialBuffers = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 1.0];
      let success = false, sweptAmount = 0, txHash = '', errorReason = '';

      for (const buffer of trialBuffers) {
        const targetAmount = evalResult.spendable - buffer;
        if (targetAmount <= 0) continue;

        try {
          const freshAccount = await server.loadAccount(wallet.public_key);
          const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
            fee: String(baseFee),
            networkPassphrase: NETWORK_PASSPHRASE
          })
          .addOperation(StellarSdk.Operation.payment({
            destination: DESTINATION,
            asset: StellarSdk.Asset.native(),
            amount: targetAmount.toFixed(7)
          }))
          .setTimeout(30).build();

          transaction.sign(sourceKeypair);
          const response = await server.submitTransaction(transaction);
          sweptAmount = targetAmount;
          txHash = response.hash;
          success = true;
          break;
        } catch (err) {
          errorReason = getErrorDetails(err);
          continue;
        }
      }

      const now = new Date().toISOString();
      if (success) {
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, transaction_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`).run(id, wallet.public_key, DESTINATION, String(sweptAmount), txHash, now);
        await notifyTelegram(bot, wallet.chat_id, `🚀 <b>SWEEP SUCCESSFUL!</b>\nBox: #${wallet.id}\nAmount: <code>${sweptAmount.toFixed(7)} Pi</code>\nHash: <code>${txHash}</code>`);
        return { status: 'SUCCESS' };
      } else {
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, status, error_details, created_at) VALUES (?, ?, ?, '0', 'FAILED', ?, ?)`).run(id, wallet.public_key, DESTINATION, errorReason, now);
        await notifyTelegram(bot, wallet.chat_id, `⚠️ <b>SWEEP FAILURE</b>\nBox: #${wallet.id}\nError: <code>${errorReason}</code>`);
        return { status: 'FAILED' };
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
      log('ERROR', 'Polling loop track exception', err.message);
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
