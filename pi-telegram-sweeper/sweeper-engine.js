'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(10, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
const MIN_THRESHOLD = Number(process.env.SWEEP_MIN_THRESHOLD || 0.002);

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const walletLocks = new Set();
let monitorRunning = false;
let monitorTimeoutId = null;

const liveWalletsMap = new Map();
// Store active dashboard message IDs per chat so we edit instead of spamming
const dashboardRegistry = new Map(); // chatId -> { statusMsgId, ledgerMsgId, history: [] }

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
  log('INFO', 'In-memory dashboard registry initialized successfully.');
  return {
    logTransaction(record) {
      // Handled via dashboard ledger feed
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

async function updateDashboard(bot, chatId, wallet, balanceInfo, lastActionText) {
  if (!bot || !chatId) return;

  let dash = dashboardRegistry.get(chatId);
  if (!dash) {
    dash = { statusMsgId: null, ledgerMsgId: null, history: [] };
    dashboardRegistry.set(chatId, dash);
  }

  if (lastActionText) {
    dash.history.unshift(lastActionText);
    if (dash.history.length > 20) dash.history.pop(); // keep last 20 entries scrollable
  }

  const statusText = `📊 <b>PI SWEEPER LIVE DASHBOARD</b>
━━━━━━━━━━━━━━━━━━━
📦 <b>Box ID:</b> #${wallet.id}
🏷️ <b>Label:</b> <code>${wallet.label}</code>
🔑 <b>Public Key:</b> <code>${wallet.publicKey || wallet.public_key}</code>
💰 <b>Spendable Balance:</b> <code>${balanceInfo.spendable.toFixed(7)} Pi</code>
⚡ <b>Status:</b> 🟢 Active 500ms Polling
━━━━━━━━━━━━━━━━━━━`;

  const ledgerContent = dash.history.length > 0 
    ? dash.history.join('\n\n') 
    : '<i>No sweep actions recorded yet. Monitoring pool...</i>';

  const ledgerText = `📜 <b>SCROLLABLE AUDIT LEDGER (Box #${wallet.id})</b>
━━━━━━━━━━━━━━━━━━━
${ledgerContent}
━━━━━━━━━━━━━━━━━━━`;

  try {
    // Update or create Status Box
    if (!dash.statusMsgId) {
      const msg = await bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
      dash.statusMsgId = msg.message_id;
    } else {
      await bot.editMessageText(statusText, { chat_id: chatId, message_id: dash.statusMsgId, parse_mode: 'HTML' }).catch(async () => {
        const msg = await bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
        dash.statusMsgId = msg.message_id;
      });
    }

    // Update or create Ledger Box
    if (!dash.ledgerMsgId) {
      const msg = await bot.sendMessage(chatId, ledgerText, { parse_mode: 'HTML' });
      dash.ledgerMsgId = msg.message_id;
    } else {
      await bot.editMessageText(ledgerText, { chat_id: chatId, message_id: dash.ledgerMsgId, parse_mode: 'HTML' }).catch(async () => {
        const msg = await bot.sendMessage(chatId, ledgerText, { parse_mode: 'HTML' });
        dash.ledgerMsgId = msg.message_id;
      });
    }
  } catch (err) {
    log('ERROR', 'Dashboard render error', err.message);
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
      
      // Always update the live status box so you see current balance without spamming
      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        await updateDashboard(bot, chatTarget, wallet, evalResult, null);
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      let targetAmount = 0;
      if (wallet.customAmount && wallet.customAmount > 0) {
        if (evalResult.spendable >= wallet.customAmount) {
          targetAmount = wallet.customAmount;
        } else {
          await updateDashboard(bot, chatTarget, wallet, evalResult, null);
          return { status: 'BELOW_FIXED_TARGET' };
        }
      } else if (evalResult.spendable > 1.0) {
        targetAmount = evalResult.spendable - 1.0;
      } else {
        targetAmount = evalResult.spendable - 0.02;
      }

      if (targetAmount <= MIN_THRESHOLD) {
        await updateDashboard(bot, chatTarget, wallet, evalResult, null);
        return { status: 'POOL_EXHAUSTED' };
      }

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';
      let remainingBalance = evalResult.spendable - targetAmount;

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
        txHash = response.hash || response.result?.hash || response.id || 'Submitted Successfully';
        success = true;
      } catch (err) {
        errorReason = getErrorDetails(err);
      }

      const timeStr = new Date().toLocaleTimeString();
      let actionLog = '';

      if (success) {
        actionLog = `🚀 [${timeStr}] <b>SWEEP SUCCESS</b>\n• Swept: <code>${sweptAmount.toFixed(7)} Pi</code>\n• Remaining: <code>${Math.max(0, remainingBalance).toFixed(7)} Pi</code>\n• Hash: <code>${txHash}</code>`;
        await updateDashboard(bot, chatTarget, wallet, { spendable: remainingBalance }, actionLog);
        return { status: 'SUCCESS' };
      } else {
        actionLog = `⚠️ [${timeStr}] <b>SWEEP FAILED</b>\n• Error: <code>${errorReason}</code>`;
        await updateDashboard(bot, chatTarget, wallet, evalResult, actionLog);
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
        await SweeperEngine.executeInstantSwipe(db, bot, wallet);
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

module.exports = { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine };
