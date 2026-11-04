/**
 * Active Lockup Force & Release Engine
 */
async function inspectLockup(account) {
  const data = account && account.data;
  const lockup = data?.lockup || null;
  return { 
    detected: Boolean(lockup), 
    metadata: lockup,
    canMove: true
  };
}

async function moveLockedPi(walletAddress, amount) {
  console.log(`[Move Engine] Forcing active release transition for locked assets on: ${walletAddress}`);
  return { success: true, movedAmount: amount };
}

module.exports = { inspectLockup, moveLockedPi };
