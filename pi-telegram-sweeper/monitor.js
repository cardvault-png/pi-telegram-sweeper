/**
 * Real-Time Event Streaming & Fallback Polling Monitor
 * Listens to persistent ledger streams AND backup polling to catch all balances instantly.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const { checkAndSweepWallet } = require('./sweeper');

function startMonitor({ db, bot, horizonUrl }) {
  const server = new StellarSdk.Horizon.Server(horizonUrl);
  console.log('[Hyper-Stream] Initializing 24/7 real-time event streaming & polling engine...');

  const wallets = db.prepare('SELECT * FROM wallets ORDER BY id').all();

  wallets.forEach(wallet => {
    // 1. Initial check immediately on startup
    checkAndSweepWallet(wallet, horizonUrl, db, bot).catch(err => console.error(`[Initial Check Error] #${wallet.id}:`, err.message));

    // 2. Open real-time event stream
    streamWalletEvents(wallet, server, db, bot, horizonUrl);
  });

  // 3. Backup Polling Loop (Checks every 10 seconds to ensure 100% reliability)
  setInterval(async () => {
    try {
      const activeWallets = db.prepare('SELECT * FROM wallets ORDER BY id').all();
      for (const wallet of activeWallets) {
        await checkAndSweepWallet(wallet, horizonUrl, db, bot);
      }
    } catch (pollErr) {
      console.error('[Polling Backup Error]:', pollErr.message);
    }
  }, 10000); // 10 seconds interval (safe against rate limits)
}

function streamWalletEvents(wallet, server, db, bot, horizonUrl) {
  console.log(`[Stream] Opening persistent live listener for Wallet #${wallet.id} (${wallet.public_key})`);

  server.payments()
    .forAccount(wallet.public_key)
    .cursor('now')
    .stream({
      onmessage: async (payment) => {
        console.log(`[Stream Event] Activity detected on Wallet #${wallet.id}! Type: ${payment.type}`);
        try {
          await checkAndSweepWallet(wallet, horizonUrl, db, bot);
        } catch (e) {
          console.error(`[Stream Execution Error] Wallet #${wallet.id}:`, e.message);
        }
      },
      onerror: (error) => {
        console.error(`[Stream Disconnect] Wallet #${wallet.id} stream dropped, reconnecting...`, error?.message || error);
      }
    });
}

module.exports = { startMonitor };
