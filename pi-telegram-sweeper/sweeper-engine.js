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
const HISTORY_FILE = path.join(DATA_DIR, 'transactions.json');

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
  if (!fs.existsSync(HISTORY_FILE)) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([]));
  }
  log('INFO', 'File-based audit storage initialized successfully.');
  return {
    logTransaction(record) {
      try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        data.push(record);
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
      } catch (e) {
        log('ERROR', 'Failed to write transaction history', e.message);
      }
    }
  };
}

const WalletManager = {
  addLiveWallet({ id, publicKey, secretKey, label, chatId, customAmount }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      public_key: publicKey, 
      secretKey, 
      secret_key: secretKey, 
      label, 
      chatId,
      chat_id: chatId,       
      customAmount: customAmount ? Number(customAmount) : null 
    });
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

    const pubKey = wallet.public_key || wallet.publicKey;
    const secKey = wallet.secret_key || wallet.secretKey;
    const chatTarget = wallet.chat_id || wallet.chatId;

    try {
      if (!DESTINATION) throw new Error('SWEEP_DESTINATION_ADDRESS configuration is empty.');
      const sourceKeypair = StellarSdk.Keypair.fromSecret(secKey);

      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      const evalResult = await this.evaluateBalance(pubKey);
      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      let targetAmount = 0;

      if (wallet.customAmount && wallet.customAmount > 0) {
        if (evalResult.spendable >= wallet.customAmount) {
          targetAmount = wallet.customAmount;
        } else {
          return { status: 'BELOW_FIXED_TARGET' };
        }
      } else if (evalResult.spendable > 1.0) {
        targetAmount = evalResult.spendable - 1.0;
      } else {
        targetAmount = evalResult.spendable - 0.02;
      }

      if (targetAmount <= MIN_THRESHOLD) {
        return { status: 'POOL_EXHAUSTED' };
      }

      log('INFO', `Wallet Box #${id} executing sweep target: ${targetAmount} Pi (Spendable: ${evalResult.spendable} Pi).`);
      await notifyTelegram(bot, chatTarget, `🔍 <b>SWEEP TRIGGERED IN RAM!</b>\nBox: #${wallet.id}\nTarget Draw: <code>${targetAmount.toFixed(7)} Pi</code>`);

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';

      try {
        const freshAccount = await server.loadAccount(pubKey);
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: String(baseFee * 15),
          networkPassphrase: NETWORK_PASSPHRASE
        })
        .addOperation(StellarSdk.Operation.payment({
          destination: DESTINATION,
          asset: StellarSdk.Asset.native(),
          amount: targetAmount.toFixed(7)
        }))
        .setTimeout(15).build();

                transaction.sign(sourceKeypair);
        const response = await server.submitTransaction(transaction);
        sweptAmount = targetAmount;
        // Fix: check multiple response formats for the hash
        txHash = response.hash || response.result?.hash || response.id || 'Submitted Successfully';
        success = true;

      const now = new Date().toISOString();
      if (success) {
        db.logTransaction({ wallet_id: id, source_address: pubKey, destination_address: DESTINATION, amount: String(sweptAmount), transaction_hash: txHash, status: 'SUCCESS', created_at: now });
        await notifyTelegram(bot, chatTarget, `🚀 <b>SWEEP SUCCESSFUL!</b>\nBox: #${wallet.id}\nAmount: <code>${sweptAmount.toFixed(7)} Pi</code>\nHash: <code>${txHash}</code>`);
        return { status: 'SUCCESS' };
      } else {
        db.logTransaction({ wallet_id: id, source_address: pubKey, destination_address: DESTINATION, amount: '0', status: 'FAILED', error_details: errorReason, created_at: now });
        await notifyTelegram(bot, chatTarget, `⚠️ <b>SWEEP FAILURE</b>\nBox: #${wallet.id}\nError: <code>${errorReason}</code>`);
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
