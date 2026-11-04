require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { openDatabase } = require('./database');
const { startMonitor } = require('./monitor');

const token = process.env.TELEGRAM_BOT_TOKEN;
const horizonUrl = (process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com').replace(/\/+$/, '');
const interval = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || 1000));
const allowed = new Set((process.env.ALLOWED_TELEGRAM_IDS || '')
  .split(',').map(x => x.trim()).filter(Boolean));

if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Configure it in environment variables.');
  process.exit(1);
}

const db = openDatabase();
const bot = new TelegramBot(token, { polling: true });

function permitted(msg) {
  return allowed.size === 0 || allowed.has(String(msg.from?.id));
}
function reply(msg, text) {
  return bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
}
function help() {
  return [
    '⚡ **Ultimate Multi-Wallet Hyper-Sweeper**',
    '',
    '`/add <PUBLIC_G_ADDRESS> <SECRET_S_KEY>` — register a wallet box with its secret key for instant sweeping',
    '`/status` — view all active individual wallet boxes, balances, and sweep counts',
    '`/remove <ID>` — stop monitoring and remove a specific wallet box',
    '`/help` — show commands',
    '',
    '🔄 *Engine Status:* Running 24/7. Automatically inspects every millisecond, waits for lockups to clear, and instantly sweeps any coin removed or deposited into your designated destination address.'
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

bot.onText(/^\/add(?:@\w+)?\s+(\S+)\s+(\S+)$/, async (msg, match) => {
  if (!permitted(msg)) return;
  const address = match[1].trim();
  const secretKey = match[2].trim();

  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    return reply(msg, '❌ Invalid public address format. Must start with `G`.');
  }
  if (!/^S[A-Z2-7]{55}$/.test(secretKey)) {
    return reply(msg, '❌ Invalid secret key format. Must start with `S`.');
  }

  try {
    const existing = db.prepare('SELECT id FROM wallets WHERE chat_id=? AND public_key=?')
      .get(String(msg.chat.id), address);
    if (existing) return reply(msg, `⚠️ Wallet box #${existing.id} is already registered and active.`);

    const result = db.prepare(
      'INSERT INTO wallets(chat_id, public_key, secret_key, created_at) VALUES(?,?,?,?)'
    ).run(String(msg.chat.id), address, secretKey, Date.now());

    await reply(msg, 
      `✅ **New Wallet Box Created!** (Box #${result.lastInsertRowid})\n` +
      `🔑 **Address:** \`${address}\`\n` +
      `📦 *Status:* Active in inspection loop. Monitoring every millisecond for deposits and lockup releases!`
    );
  } catch (e) {
    console.error('Add wallet failed:', e.message);
    return reply(msg, '❌ Could not save that wallet box. Check server logs.');
  }
});

bot.onText(/^\/status(?:@\w+)?$/, async msg => {
  if (!permitted(msg)) return;
  const rows = db.prepare('SELECT id, public_key, last_native, sweep_count, last_seen_at FROM wallets WHERE chat_id=? ORDER BY id')
    .all(String(msg.chat.id));
  if (!rows.length) return reply(msg, '📭 No wallet boxes registered yet. Use `/add <G_ADDRESS> <S_SECRET_KEY>` to add one.');

  const boxes = rows.map(w => {
    const balance = w.last_native == null ? 'Checking...' : `${w.last_native} Pi`;
    const checked = w.last_seen_at ? new Date(w.last_seen_at).toLocaleTimeString() : 'pending';
    return `📦 **Wallet Box #${w.id}**\n` +
           `├ 🔑 Address: \`${w.public_key}\`\n` +
           `├ 💰 Current Balance: \`${balance}\`\n` +
           `├ ⚡ Total Sweeps Executed: \`${w.sweep_count}\`\n` +
           `└ 🕒 Last Inspected: \`${checked}\``;
  });

  await reply(msg, `📊 **Active Wallet Boxes (${rows.length})**\n\n` + boxes.join('\n\n'));
});

bot.onText(/^\/remove(?:@\w+)?\s+(\d+)$/, async (msg, match) => {
  if (!permitted(msg)) return;
  const id = Number(match[1]);
  const result = db.prepare('DELETE FROM wallets WHERE id=? AND chat_id=?')
    .run(id, String(msg.chat.id));
  await reply(msg, result.changes
    ? `🗑️ Wallet box #${id} successfully removed from monitoring.`
    : `❌ Wallet box #${id} not found.`);
});

startMonitor({ db, bot, horizonUrl, interval });

bot.on('polling_error', e => console.error('Telegram polling error:', e.message));
process.on('SIGINT', () => { bot.stopPolling(); db.close(); process.exit(0); });
process.on('SIGTERM', () => { bot.stopPolling(); db.close(); process.exit(0); });

console.log(`Ultimate Multi-Wallet Sweeper active; polling every ${interval}ms.`);
