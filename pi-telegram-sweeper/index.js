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
 * Mode 1 (Tiered Auto Strategy): /addwallet [BoxId] [SecretKey] [Label_Optional]
 * Mode 2 (Fixed Custom Amount):  /addwallet [BoxId] [SecretKey] [Label_Optional] [CustomAmount]
 */
bot.onText(/\/addwallet (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const inputParams = match[1].split(' ');
  
  if (inputParams.length < 2) {
    return bot.sendMessage(chatId, '❌ <b>Format Mismatch.</b>\nUse: <code>/addwallet [BoxId] [SecretKey] [Label_Optional] [CustomAmount_Optional]</code>', { parse_mode: 'HTML' });
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
    } catch (e) {}

    let strategyText = customAmount 
      ? `🎯 Targeted Custom Amount: <b>${customAmount} Pi</b>` 
      : `⚡ Tiered Auto-Strategy (Leaves 1 Pi for big balances, 0.02 Pi for low balances).`;

    bot.sendMessage(chatId, `✅ <b>Wallet Loaded into Memory!</b>\n📦 Box ID: <code>${id}</code>\n🏷️ Label: <code>${label}</code>\n🔑 Derived Public Key: <code>${publicKey}</code>\n${strategyText}\n\n🗑️ <i>Input message deleted from history for security protocol safety. Monitoring is live...</i>`, { parse_mode: 'HTML' });
  } catch (err) {
    bot.sendMessage(chatId, `❌ <b>Structural Validation Fault:</b>\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
});

// Command: /status - View current volatile tracking nodes active in system memory
bot.onText(/\/status/, (msg) => {
  const activeList = WalletManager.getLiveWallets();
  if (activeList.length === 0) {
    return bot.sendMessage(msg.chat.id, 'ℹ️ No wallets currently stored inside volatile running memory matrices.');
  }

  let textReport = `📝 <b>Active Volatile Monitoring Nodes (${activeList.length}):</b>\n\n`;
  activeList.forEach(w => {
    let modeText = w.customAmount ? `🎯 Target: <b>${w.customAmount} Pi</b>` : `⚡ Mode: <b>Tiered Auto</b>`;
    textReport += `📦 <b>Box:</b> ${w.id} | 🏷️ <b>Label:</b> ${w.label}\n🔑 Public Key: <code>${w.publicKey || w.public_key}</code>\n${modeText}\n\n`;
  });
  bot.sendMessage(msg.chat.id, textReport, { parse_mode: 'HTML' });
});

bot.onText(/\/removewallet (.+)/, (msg, match) => {
  const targetId = match[1].trim();
  const removed = WalletManager.removeLiveWallet(targetId);
  bot.sendMessage(msg.chat.id, removed ? `🗑️ Box #${targetId} wiped clean out of engine memory slots.` : `❌ Box #${targetId} not found active in running array tracks.`);
});
