const { fetchAccount } = require('./pi-network');
const { inspectLockup } = require('./coin-remover');
const { checkAndSweepWallet } = require('./sweeper');

function nativeBalance(account) {
  const native = (account.balances || []).find(b => b.asset_type === 'native');
  return native ? Number(native.balance) : 0;
}

function startMonitor({ db, bot, horizonUrl, interval }) {
  const sweepInterval = Math.min(Number(interval || 1000), 1000);
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const wallets = db.prepare('SELECT * FROM wallets ORDER BY id').all();
      for (const wallet of wallets) {
        try {
          const account = await fetchAccount(horizonUrl, wallet.public_key);
          const balance = nativeBalance(account);
          const previous = wallet.last_native == null ? null : Number(wallet.last_native);

          db.prepare('UPDATE wallets SET last_native=?, last_seen_at=? WHERE id=?')
            .run(String(balance), Date.now(), wallet.id);

                    if (previous === null) {
            await bot.sendMessage(wallet.chat_id,
              `📦 **Wallet Box #${wallet.id} Initialized**\n` +
              `🔑 Address: \`${wallet.public_key}\`\n` +
              `💰 Initial Balance Inside: \`${balance} Pi\`\n` +
              `🔄 *Active Inspection Counter & Sweeper running 24/7.*`,
              { parse_mode: 'Markdown' }
            );
          }

          await inspectLockup(account);
          await checkAndSweepWallet(wallet, horizonUrl, db, bot);

        } catch (e) {
          console.error(`Wallet Box #${wallet.id} check failed:`, e.message);
        }
      }
    } finally {
      running = false;
    }
  }

  tick().catch(e => console.error('Initial monitor tick failed:', e.message));
  setInterval(() => tick().catch(e => console.error('Monitor tick failed:', e.message)), sweepInterval);
}

module.exports = { startMonitor };
