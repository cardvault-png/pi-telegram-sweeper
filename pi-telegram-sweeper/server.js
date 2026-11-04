require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { openDatabase } = require('./database');
const { startMonitor } = require('./monitor');

const token = process.env.TELEGRAM_BOT_TOKEN;
const horizonUrl = (process.env.PI_HORIZON_URL || '').replace(/\/+$/, '');
const interval = Math.max(5000, Number(process.env.POLL_INTERVAL_MS || 10000));
const allowed = new Set((process.env.ALLOWED_TELEGRAM_IDS || '')
  .split(',').map(x => x.trim()).filter(Boolean));

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and configure it.');
  process.exit(1);
}
if (!horizonUrl) {
  console.error('Missing PI_HORIZON_URL. Set the verified Pi Mainnet Horizon endpoint.');
  process.exit(1);
}

const db = openDatabase();
const bot = new TelegramBot(token, { polling: true });

function permitted(msg) {
  return allowed.size === 0 || allowed.has(String(msg.from?.id));
}
function reply(msg, text) {
  return bot.sendMessage(msg.chat.id, text, { disable_web_page_preview: true });
}
function help() {
  return [
    '🛰️ Pi Wallet Monitor',
    '',
    '/add G...PUBLIC_ADDRESS — register a public wallet',
    '/status — list your monitored wallets',
    '/remove ID — stop monitoring one wallet',
    '/help — show commands',
    '',
    'Security: register public addresses only. Never send a 24-word passphrase or secret key.',
    'This bot monitors balances. It does not sign or submit wallet transactions.'
  ].join('\n');
}

bot.onText(/^\/start(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  await reply(msg, help());
});
bot.onText(/^\/help(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  await reply(msg, help());
});
bot.onText(/^\/add(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
  if (!permitted(msg)) return;
  const address = match[1].trim();
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    return reply(msg, 'That does not look like a Stellar-style public address. Use the public G... address only.');
  }
  try {
    const existing = db.prepare('SELECT id FROM wallets WHERE chat_id=? AND public_key=?')
      .get(String(msg.chat.id), address);
    if (existing) return reply(msg, `Already monitoring wallet #${existing.id}.`);
    const result = db.prepare(
      'INSERT INTO wallets(chat_id, public_key, created_at) VALUES(?,?,?)'
    ).run(String(msg.chat.id), address, Date.now());
    await reply(msg, `✅ Wallet #${result.lastInsertRowid} registered.\n${address}\n\nMonitoring continues on Railway while your phone is offline.`);
  } catch (e) {
    console.error('Add wallet failed:', e.message);
    await reply(msg, 'Could not save that wallet. Check the Railway logs.');
  }
});
bot.onText(/^\/status(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  const rows = db.prepare('SELECT id, public_key, last_native, last_seen_at FROM wallets WHERE chat_id=? ORDER BY id')
    .all(String(msg.chat.id));
  if (!rows.length) return reply(msg, 'No wallets registered. Use /add G...PUBLIC_ADDRESS.');
  const lines = rows.map(w => {
    const balance = w.last_native == null ? 'Not yet checked' : `${w.last_native} Pi`;
    const checked = w.last_seen_at ? new Date(w.last_seen_at).toISOString() : 'pending';
    return `#${w.id}  ${w.public_key}\nBalance: ${balance}\nLast checked: ${checked}`;
  });
  await reply(msg, `📊 Monitored wallets (${rows.length})\n\n${lines.join('\n\n')}`);
});
bot.onText(/^\/remove(?:@\w+)?\s+(\d+)$/, async (msg, match) => {
  if (!permitted(msg)) return;
  const id = Number(match[1]);
  const result = db.prepare('DELETE FROM wallets WHERE id=? AND chat_id=?')
    .run(id, String(msg.chat.id));
  await reply(msg, result.changes
    ? `🗑️ Wallet #${id} removed from monitoring.`
    : `Wallet #${id} was not found in your list.`);
});

startMonitor({ db, bot, horizonUrl, interval });

bot.on('polling_error', e => console.error('Telegram polling error:', e.message));
process.on('SIGINT', () => { bot.stopPolling(); db.close(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); db.close(); process.exit(0); });

console.log(`Pi wallet monitor started; polling every ${interval}ms.`);
