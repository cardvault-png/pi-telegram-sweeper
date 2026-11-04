const { fetchAccount } = require('./pi-network');
const { inspectLockup } = require('./coin-remover');
const { checkAndSweepWallet } = require('./sweeper');

function nativeBalance(account) {
  const native = (account.balances || []).find(b => b.asset_type === 'native');
  return native ? Number(native.balance) : 0;
}

function startMonitor({ db, bot, horizonUrl, interval }) {
  // Enforce high-frequency 3-second sweep interval as requested
  const sweepInterval = 3000;
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

          if (previous !== null && balance > previous) {
            const received = (balance - previous).toFixed(7).replace(/0+$/, '').replace(/\.$/, '');
            await bot.sendMessage(wallet.chat_id,
              `🪙 Incoming Pi balance detected
Wallet: #${wallet.id}
Received: ${received} Pi
Available Balance: ${balance} Pi`);
          } else if (previous === null) {
            await bot.sendMessage(wallet.chat_id,
              `👀 Wallet #${wallet.id} monitored.
Balance: ${balance} Pi`);
          }

          // Aggressive 3-second lockup inspection and instant sweep execution
          await inspectLockup(account);
          await checkAndSweepWallet(wallet, horizonUrl, bot);

        } catch (e) {
          console.error(`Wallet #${wallet.id} check failed:`, e.message);
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
