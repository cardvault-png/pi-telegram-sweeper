'use strict';

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const StellarSdk = require('@stellar/stellar-sdk');
const { WalletManager, startSweeperEngine } = require('./sweeper-engine');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN environment variable missing!');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log('[System Init] Telegram dynamic matrix-updater active.');
startSweeperEngine(bot);

bot.onText(/\/addwallet (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!match || !match[1]) return;
  
  const inputParams = match[1].split(' ');
  if (inputParams.length < 2) {
    return bot.sendMessage(chatId, '❌ <b>Format Mismatch.</b>\nUse: <code>/addwallet [BoxId] [SecretKey] [TargetAddress_Optional] [Label_Optional] [Amount_Optional]</code>', { parse_mode: 'HTML' });
  }

  const id = inputParams[0];
  const secretKey = inputParams[1];
  
  let destination = null;
  let label = `Wallet_${id}`;
  let customAmount = null;

  if (inputParams[2]) {
    try {
      StellarSdk.StrKey.decodeEd25519PublicKey(inputParams[2]);
      destination = inputParams[2];
      label = inputParams[3] || `Wallet_${id}`;
      customAmount = inputParams[4] ? inputParams[4] : null;
    } catch (e) {
      destination = null;
      label = inputParams[2];
      customAmount = inputParams[3] ? inputParams[3] : null;
    }
  }

  try {
    const keypair = StellarSdk.Keypair.fromSecret(secretKey);
    const publicKey = keypair.publicKey();

    WalletManager.addLiveWallet({
      id,
      publicKey,
      secretKey,
      destination,
      label,
      chatId: String(chatId),
      customAmount
    });

    try {
      await bot.deleteMessage(chatId, msg.message_id);
    } catch (e) {}

    let routeMsg = destination ? `📥 Route Target: <code>${destination}</code>` : `🛡️ Fallback Master Target active.`;
    let strategyMsg = customAmount ? `🎯 Targeted Sweep: <b>${customAmount} Pi</b>` : `⚡ Adaptive Maximal Pool Sweep activated.`;

    bot.sendMessage(chatId, `✅ <b>Wallet Loaded into Memory Matrix!</b>\n📦 Box ID: <code>${id}</code>\n🔑 Address: <code>${publicKey}</code>\n${routeMsg}\n${strategyMsg}`, { parse_mode: 'HTML' });
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
    let routeText = w.destination ? `📥 Custom Address: <code>${w.destination}</code>` : `🛡️ Fallback Master Variable Configured`;
    textReport += `📦 <b>Box:</b> ${w.id} | 🏷️ <b>Label:</b> ${w.label}\n🔑 Source Address: <code>${w.publicKey}</code>\n${routeText}\n${modeText}\n\n`;
  });
  bot.sendMessage(msg.chat.id, textReport, { parse_mode: 'HTML' });
});

bot.onText(/\/removewallet (.+)/, (msg, match) => {
  if (!match || !match[1]) return;
  const targetId = match[1].trim();
  const removed = WalletManager.removeLiveWallet(targetId);
  bot.sendMessage(msg.chat.id, removed ? `🗑️ Box #${targetId} completely wiped out of memory tracks.` : `❌ Box #${targetId} not found.`);
});
