'use strict';

const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS || '';
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.SWEEP_POLL_INTERVAL_MS || 500));
const MIN_THRESHOLD = Number(process.env.SWEEP_MIN_THRESHOLD || 0.002);

const server = new StellarSdk.Horizon.Server(HORIZON_URL);
const walletLocks = new Set();
let monitorRunning = false;
let monitorTimeoutId = null;

// IN-MEMORY STORAGE (RAM) - Keys are never saved to disk
const liveWalletsMap = new Map();
const transactionHistory = [];

function getErrorDetails(error) {
  const data = error?.response?.data;
  if (data) {
    if (data.extras && data.extras.result_codes) {
      return `REJECTED -> Tx Code: ${data.extras.result_codes.transaction}, Op Codes: ${JSON.stringify(data.extras.result_codes.operations)}`
    }
    return data.detail || data.title || JSON.stringify(data);
  }
  return error?.message || String(error);
}

function log(level, message, details) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [Sweeper ${level}] ${message}`, details || '');
}

function initDatabase() {
  log('INFO', 'Pure in-memory RAM transaction registry initialized successfully.');
  return {
    logTransaction(record) {
      transactionHistory.push(record);
      if (transactionHistory.length > 500) transactionHistory.shift();
    }
  };
}

const WalletManager = {
  addLiveWallet({ id, publicKey, secretKey, label, chatId }) {
    liveWalletsMap.set(String(id), { 
      id, 
      publicKey, 
      public_key: publicKey, 
      secretKey, 
      secret_key: secretKey, 
      label, 
      chatId,
      chat_id: chatId 
    });
    log('INFO', `Wallet Box #${id} loaded successfully into volatile system memory.`);
  },
  
  removeLiveWallet(id) {
    return liveWalletsMap.delete(String(id));
  },

  getLiveWallets() {
    return Array.from(liveWalletsMap.values());
  }
};

// Fire-and-forget notification dispatch: sends information to Telegram immediately without blocking
function notifyTelegramAsync(bot, chatId, message) {
  if (!bot || !chatId) return;
  bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch((error) => {
    log('ERROR', 'Telegram notification dispatch failed', error.message);
  });
}

// Helper to evaluate claimable balance predicates recursively against current time
function isPredicateMet(predicate, nowSec) {
  if (!predicate) return true;
  if (predicate.unconditional === true) return true;
  
  if (predicate.abs_before) {
    const absTime = Math.floor(new Date(predicate.abs_before).getTime() / 1000);
    if (nowSec >= absTime) return false;
  }
  if (predicate.abs_before_epoch) {
    if (nowSec >= Number(predicate.abs_before_epoch)) return false;
  }
  if (predicate.and_predicates && Array.isArray(predicate.and_predicates)) {
    return predicate.and_predicates.every(p => isPredicateMet(p, nowSec));
  }
  if (predicate.or_predicates && Array.isArray(predicate.or_predicates)) {
    return predicate.or_predicates.some(p => isPredicateMet(p, nowSec));
  }
  if (predicate.not_predicate) {
    return !isPredicateMet(predicate.not_predicate, nowSec);
  }
  
  return true;
}

const SweeperEngine = {
  async evaluateBalance(publicKey) {
    try {
      const account = await server.loadAccount(publicKey);
      const native = account.balances.find(b => b.asset_type === 'native' || b.asset_code === 'PI');
      
      let ledgerTotal = native ? Number(native.balance || 0) : 0;
      let locked = 0;
      if (native && Object.prototype.hasOwnProperty.call(native, 'locked_balance')) {
        locked = Number(native.locked_balance || 0);
      }

      let claimableTotal = 0;
      let claimableIds = [];
      const nowSec = Math.floor(Date.now() / 1000);

      try {
        const claimableResp = await server.claimableBalances().claimant(publicKey).call();
        if (claimableResp && claimableResp.records) {
          for (const cb of claimableResp.records) {
            if (cb.asset === 'native' || cb.asset.includes('PI')) {
              const claimantEntry = cb.claimants.find(c => c.destination === publicKey);
              if (claimantEntry && claimantEntry.predicate) {
                if (!isPredicateMet(claimantEntry.predicate, nowSec)) {
                  continue; 
                }
              }
              claimableTotal += Number(cb.amount || 0);
              claimableIds.push(cb.id);
            }
          }
        }
      } catch (claimErr) {}

      const totalSpendable = Math.max(0, (ledgerTotal - locked) + claimableTotal);
      const verified = (ledgerTotal > 0 || claimableTotal > 0);

      return { 
        spendable: totalSpendable, 
        verified, 
        claimableIds,
        sequenceNumber: account.sequence,
        subentryCount: account.subentry_count || 0
      };
    } catch (error) {
      return { spendable: 0, verified: false, claimableIds: [], sequenceNumber: null, subentryCount: 0 };
    }
  },

    async executeInstantSweep(db, bot, wallet) {
    const id = wallet.id;
    if (walletLocks.has(id)) return { status: 'LOCKED' };
    walletLocks.add(id);

    try {  // <--- The main try block begins immediately here
      if (!DESTINATION) throw new Error('SWEEP_DESTINATION_ADDRESS configuration is empty.');
      const evalResult = await this.evaluateBalance(wallet.public_key);

      if (!evalResult.verified || evalResult.spendable <= MIN_THRESHOLD) {
        return { status: 'NO_SWEEPABLE_FUNDS' };
      }

      log('INFO', `Wallet Box #${id} matches eligible threshold: ${evalResult.spendable} Pi.`);

      notifyTelegramAsync(bot, wallet.chat_id, `🔍 <b>SWEEP DETECTED IN RAM!</b>\nBox: #${wallet.id}\nAvailable: <code>${evalResult.spendable.toFixed(7)} Pi</code>`);

      const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret_key);
      let baseFee = 100000; // Pi Mainnet standard minimum fee fallback (0.01 Pi in stroops)
      try { baseFee = await server.fetchBaseFee(); } catch (e) { baseFee = 100000; }

      let success = false;
      let sweptAmount = 0;
      let txHash = '';
      let errorReason = '';

      try {
        const freshAccountData = await server.loadAccount(wallet.public_key);
        const accountObject = new StellarSdk.Account(wallet.public_key, freshAccountData.sequence);

        let totalOpsCount = 1; // Payment operation
        if (evalResult.claimableIds && evalResult.claimableIds.length > 0) {
          totalOpsCount += evalResult.claimableIds.length;
        }

        const totalFeeInPi = (Number(baseFee) * totalOpsCount) / 10000000;
        
        // Use exact subentry count without unsafe subtraction for sponsored claimable balances
        const effectiveSubentries = freshAccountData.subentry_count || 0;
        const baseReservePerEntry = 0.01; 
        const mandatoryReserve = (2 + effectiveSubentries) * baseReservePerEntry;

        const reserveBuffer = mandatoryReserve + totalFeeInPi;
        const targetAmount = evalResult.spendable - reserveBuffer;

        if (targetAmount > 0) {
          let txBuilder = new StellarSdk.TransactionBuilder(accountObject, {
            fee: String(baseFee * totalOpsCount),
            networkPassphrase: NETWORK_PASSPHRASE
          });

          if (evalResult.claimableIds && evalResult.claimableIds.length > 0) {
            for (const balanceId of evalResult.claimableIds) {
              txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }));
            }
          }

          txBuilder.addOperation(StellarSdk.Operation.payment({
            destination: DESTINATION,
            asset: StellarSdk.Asset.native(),
            amount: targetAmount.toFixed(7)
          }));
          
           const transaction = txBuilder.setTimeout(30).build();
          transaction.sign(sourceKeypair);

          let response;
          try {
            response = await server.submitTransaction(transaction);
          } catch (submitErr) {
            const errData = submitErr?.response?.data || submitErr?.data || submitErr;
            const codes = errData?.extras?.result_codes;
            if (codes) {
              throw new Error(`Horizon Rejected -> Tx: ${codes.transaction} | Ops: ${JSON.stringify(codes.operations)}`);
            }
            throw new Error(`Horizon Rejected -> ${errData?.detail || errData?.title || submitErr.message}`);
          }

          sweptAmount = targetAmount;
          txHash = response?.hash || response?.result_xdr;
          
          if (!txHash) {
            throw new Error('Transaction submitted but no transaction hash returned.');
          }
          success = true;

        } else {
          errorReason = 'Calculated target amount is below zero after accounting for exact Pi reserves and fees.';
        }
      } catch (err) {
        const errData = err?.response?.data || err?.data || err;
        const codes = errData?.extras?.result_codes;
        if (codes) {
          errorReason = `Horizon Rejected -> Tx Code: ${codes.transaction} | Op Codes: ${JSON.stringify(codes.operations)}`;
        } else {
          errorReason = errData?.detail || errData?.title || err?.message || String(err);
        }
      }

      const now = new Date().toISOString();
      if (success) {
        db.logTransaction({ wallet_id: id, source_address: wallet.public_key, destination_address: DESTINATION, amount: String(sweptAmount), transaction_hash: txHash, status: 'SUCCESS', created_at: now });
        notifyTelegramAsync(bot, wallet.chat_id, `🚀 <b>SWEEP SUCCESSFUL!</b>\nBox: #${wallet.id}\nAmount: <code>${sweptAmount.toFixed(7)} Pi</code>\nHash: <code>${txHash}</code>`);
        return { status: 'SUCCESS' };
      } else {
        db.logTransaction({ wallet_id: id, source_address: wallet.public_key, destination_address: DESTINATION, amount: '0', status: 'FAILED', error_details: errorReason, created_at: now });
        notifyTelegramAsync(bot, wallet.chat_id, `⚠️ <b>SWEEP FAILURE</b>\nBox: #${wallet.id}\nError: <code>${errorReason}</code>`);
        return { status: 'FAILED' };
      }
    } catch (criticalError) {
      log('ERROR', `Loop Failure on Box #${id}`, criticalError.message);
    } finally {
      walletLocks.delete(id);
    }
  }
};

function startSweeperEngine(db, bot) {
  if (monitorRunning) return;
  monitorRunning = true;

  const corePollingCycle = async () => {
    if (!monitorRunning) return;
    try {
      const wallets = WalletManager.getLiveWallets();
      for (const wallet of wallets) {
        await SweeperEngine.executeInstantSweep(db, bot, wallet);
      }
    } catch (err) {
      log('ERROR', 'Polling loop track exception', err.message);
    }
    if (monitorRunning) monitorTimeoutId = setTimeout(corePollingCycle, POLL_INTERVAL_MS);
  };
  corePollingCycle();
}

function stopSweeperEngine() {
  monitorRunning = false;
  if (monitorTimeoutId) clearTimeout(monitorTimeoutId);
}

module.exports = { initDatabase, WalletManager, startSweeperEngine, stopSweeperEngine, notifyTelegram: notifyTelegramAsync };
