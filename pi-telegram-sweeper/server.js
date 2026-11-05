/**
 * Ultimate Multi-Wallet Hyper-Sweeper Controller
 * Displays passphrase/secret key on creation & gives a rich multi-wallet summary on /status.
 */

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const StellarSdk = require('@stellar/stellar-sdk');
const { startMonitor } = require('./monitor');
const { checkAndSweepWallet } = require('./sweeper');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';

if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is missing in environment variables.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const db = new Database('wallets.db');

// Initialize Database Table
db.prepare(`
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    public_key TEXT UNIQUE,
    secret_key TEXT,
    sweep_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

console.log('[Database] Wallet storage initialized successfully.');

// Start 24/7 Real-Time Monitoring & Sweeping Engine
startMonitor({ db, bot, horizonUrl: HORIZON_URL });

// Telegram Bot Commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    `⚡ **Ultimate Multi-Wallet Hyper-Sweeper Active**\n\n` +
    `Welcome! This bot monitors your Pi Network wallets and sweeps available balances automatically in real-time.\n\n` +
    `📌 **Commands:**\n` +
    `/add <SECRET_KEY_OR_PASSPHRASE> — Register and start monitoring a wallet box\n` +
    `/status — View all active wallet boxes, balances, lockups, and sweep records\n` +
    `/remove <ID> — Stop monitoring a specific wallet box`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `📖 **Commands Guide:**\n\n` +
    `/add <passphrase or S-key> - Add wallet\n` +
    `/status - View all wallets and performance\n` +
    `/remove <ID> - Delete wallet box`,
    { parse_mode: 'Markdown' }
  );
});

// Upgraded /add command: Confirms creation and shows your secret key/passphrase back to you
bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();

  try {
    let secretKeyToStore = input;
    let publicKey = '';

    const words = input.split(/\s+/);
    if (words.length > 1) {
      bot.sendMessage(chatId, `🔄 Processing passphrase and deriving wallet credentials...`, { parse_mode: 'Markdown' });
      const keypair = StellarSdk.Keypair.fromSecret(input);
      publicKey = keypair.publicKey();
    } else {
      const keypair = StellarSdk.Keypair.fromSecret(input);
      publicKey = keypair.publicKey();
      secretKeyToStore = input;
    }

    const stmt = db.prepare('INSERT INTO wallets (chat_id, public_key, secret_key) VALUES (?, ?, ?)');
    const info = stmt.run(String(chatId), publicKey, secretKeyToStore);

    bot.sendMessage(chatId, 
      `✅ **Wallet Box Created Successfully! (Box #${info.lastInsertRowid})**\n\n` +
      `🔑 **Derived Public Address:** \`${publicKey}\`\n` +
      `🔐 **Saved Passphrase/Secret Key:** \`${secretKeyToStore}\`\n\n` +
      `📦 *Status:* Active in real-time stream. Monitoring and ready to sweep available balance!`,
      { parse_mode: 'Markdown' }
    );

    const newWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(info.lastInsertRowid);
    if (newWallet) {
      await checkAndSweepWallet(newWallet, HORIZON_URL, db, bot);
    }
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      bot.sendMessage(chatId, '⚠️ This wallet is already registered in the system.');
    } else {
      bot.sendMessage(chatId, `❌ Error parsing key or passphrase: ${error.message}. Please check and try again.`);
    }
  }
});

// Upgraded /status command: Lists all added wallets with full details (balances, lockups, sweeps)
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const wallets = db.prepare('SELECT * FROM wallets WHERE chat_id = ?').all(String(chatId));

  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '📭 You have no active wallet boxes registered. Use `/add <passphrase or S-key>` to add one.', { parse_mode: 'Markdown' });
  }

  let response = `📊 **Active Wallet Boxes Overview (${wallets.length})**\n\n`;
  const server = new StellarSdk.Horizon.Server(HORIZON_URL);

  for (const w of wallets) {
    let totalBalance = 0;
    let lockedBalance = 0;
    let availableBalance = 0;
    let statusText = 'Active';

    try {
      const acc = await server.loadAccount(w.public_key);
      const native = acc.balances.find(b => b.asset_type === 'native');
      if (native) {
        totalBalance = parseFloat(native.balance || 0);
        lockedBalance = parseFloat(native.locked_balance || 0);
        availableBalance = totalBalance - lockedBalance;
      }
    } catch (e) {
      statusText = 'Unfunded / Error';
    }

    response += `📦 **Wallet Box #${w.id}**\n` +
                `├ 🔑 Address: \`${w.public_key}\`\n` +
                `├ 🔐 Key/Passphrase: \`${w.secret_key}\`\n` +
                `├ 💰 Available Balance: \`${availableBalance.toFixed(7)} Pi\`\n` +
                `├ 🔒 Locked Balance: \`${lockedBalance.toFixed(7)} Pi\`\n` +
                `├ 📈 Total Balance: \`${totalBalance.toFixed(7)} Pi\`\n` +
                `├ ⚡ Total Sweeps Executed: \`${w.sweep_count}\`\n` +
                `└ 🕒 Last Inspected: \`${new Date().toLocaleTimeString()}\`\n\n`;
  }

  bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
});

bot.onText(/\/remove (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const id = match[1];

  const result = db.prepare('DELETE FROM wallets WHERE id = ? AND chat_id = ?').run(id, String(chatId));

  if (result.changes > 0) {
    bot.sendMessage(chatId, `🗑️ Wallet Box #${id} has been successfully removed and stopped.`);
  } else {
    bot.sendMessage(chatId, `❌ Wallet Box #${id} not found or unauthorized.`);
  }
});

console.log('[Server] Telegram Bot server running and listening for commands.');
