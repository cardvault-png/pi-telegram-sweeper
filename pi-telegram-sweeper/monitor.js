/**
 * Real-Time Event Streaming Monitor
 * Listens to persistent ledger streams for instant reaction to deposits and lockup releases.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const { checkAndSweepWallet } = require('./sweeper');

function startMonitor({ db, bot, horizonUrl }) {
  const server = new StellarSdk.Horizon.Server(horizonUrl);
  console.log('[Hyper-Stream] Initializing 24/7 real-time event streaming engine...');

  const wallets = db.prepare('SELECT * FROM wallets ORDER BY id').all();

  wallets.forEach(wallet => {
    streamWalletEvents(wallet, server, db, bot, horizonUrl);
  });
}

function streamWalletEvents(wallet, server, db, bot, horizonUrl) {
  console.log(`[Stream] Opening persistent live listener for Wallet #${wallet.id} (${wallet.public_key})`);

  // Stream payments directly from the Pi network ledger in real-time
  server.payments()
    .forAccount(wallet.public_key)
    .cursor('now')
    .stream({
      onmessage: async (payment) => {
        console.log(`[Stream Event] Activity detected on Wallet #${wallet.id}! Type: ${payment.type}`);
        try {
          // Immediately trigger sweep upon receiving a ledger event
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
