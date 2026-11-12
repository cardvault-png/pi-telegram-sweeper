// ==========================================
// index.js - Hardened Entry Point File for Pi RAM Sweeper Bot
// ==========================================
'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const StellarSdk = require('@stellar/stellar-sdk');
const { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram } = require('./sweeper-engine');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID ? String(process.env.ALLOWED_CHAT_ID) : '';

if (!TOKEN) {
  console.error('CRITICAL: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

// Initialize Telegram bot with polling and in-memory database registry
const bot = new TelegramBot(TOKEN, { polling: true });
const db = initDatabase();

console.log('Starting Pi Mainnet Pure-RAM Sweeper Bot Entry Point...');

// Automatically start the continuous background polling sweeper engine
startSweeperEngine(db, bot);

// Optional: Notify owner on startup that RAM was initialized (Railway container restart alert)
if (ALLOWED_CHAT_ID) {
  notifyTelegram(bot, ALLOWED_CHAT_ID, `⚠️ <b>Bot Container Restarted</b>\nVolatile memory wiped. Please re-load your active wallet boxes using <code>/addwallet</code>.`);
}

// Security Middleware: Restricts access to authorized owner chat ID if configured
function isAuthorized(chatId) {
  if (!ALLOWED_CHAT_ID) return true; // If not set, allow all (though setting it is strongly recommended)
  return String(chatId) === ALLOWED_CHAT_ID;
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) return;

  await notifyTelegram(bot, chatId, 
    `🤖 <b>Pi Mainnet RAM Sweeper Bot Active (Secured)</b>\n\n` +
    `Commands:\n` +
    `• /addwallet [BoxId] [SecretKey] [Label]\n` +
    `• /removewallet [BoxId]\n` +
    `• /status\n` +
    `• /stop`
  );
});

bot.onText(/\/addwallet\s+(\S+)\s+(\S+)(?:\s+(.*))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) return;

  // SECURITY FIX: Immediately delete user message containing plaintext secret key from Telegram chat history
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (delErr) {
    console.log('Could not delete command message (ensure bot has delete messages admin permission if in group):', delErr.message);
  }

  const boxId = match[1];
  const secretKey = match[2];
  const label = match[3] || `Wallet_${boxId}`;

  try {
    const keypair = StellarSdk.Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();

    WalletManager.addLiveWallet({
      id: boxId,
      publicKey: publicKey,
      secretKey: secretKey,
      label: label,
      chatId: chatId
    });

    await notifyTelegram(bot, chatId, `✅ <b>Wallet Box #${boxId} Loaded Into RAM Securely!</b>\nLabel: <code>${label}</code>\nPublic Key: <code>${publicKey}</code>\n<i>(Plaintext key message deleted from chat history).</i>`);
  } catch (err) {
    await notifyTelegram(bot, chatId, `❌ <b>Invalid Secret Key:</b> <code>${err.message}</code>`);
  }
});

bot.onText(/\/removewallet\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) return;

  const boxId = match[1];
  const removed = WalletManager.removeLiveWallet(boxId);
  if (removed) {
    await notifyTelegram(bot, chatId, `🗑️ Wallet Box #${boxId} removed from RAM.`);
  } else {
    await notifyTelegram(bot, chatId, `⚠️ Wallet Box #${boxId} not found in memory.`);
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) return;

  const wallets = WalletManager.getLiveWallets();
  if (wallets.length === 0) {
    await notifyTelegram(bot, chatId, `📂 <b>Active Volatile Monitoring Nodes (0)</b>\nNo wallets currently loaded in RAM.`);
    return;
  }
  let text = `📂 <b>Active Volatile Monitoring Nodes (${wallets.length}):</b>\n`;
  for (const w of wallets) {
    text += `\n📦 Box: ${w.id} | 🏷️ ${w.label}\n🔑 <code>${w.publicKey}</code>`;
  }
  await notifyTelegram(bot, chatId, text);
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAuthorized(chatId)) return;

  stopSweeperEngine();
  await notifyTelegram(bot, chatId, `🛑 Sweeper engine halted.`);
});

process.on('SIGINT', () => {
  stopSweeperEngine();
  process.exit(0);
});
