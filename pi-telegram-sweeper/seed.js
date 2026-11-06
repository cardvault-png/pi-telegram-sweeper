'use strict';

/**
 * Pi Network Sweeper System - Database Seeder Utility
 * Manually populates or updates wallet box configurations inside the persistent SQLite database.
 * Run this directly using: node seed.js
 */

require('dotenv').config();
const { initDatabase, WalletManager } = require('./sweeper-engine');

function runSeeder() {
  console.log('[Seeder INFO] Opening persistent database channel...');
  const db = initDatabase();

  // Define the raw array of multi-wallet credentials to inject securely
  const walletBoxesToSeed = [
    {
      id: "box_01",
      publicKey: "GAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      secretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      label: "Secure Vault Alpha",
      chatId: process.env.TELEGRAM_DEFAULT_CHAT_ID // Uses the fallback ID from your .env
    },
    {
      id: "box_02",
      publicKey: "GBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      secretKey: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      label: "Operational Node Beta",
      chatId: "987654321" // Or supply a completely unique chat ID per box if desired
    }
  ];

  console.log(`[Seeder INFO] Beginning database sync for ${walletBoxesToSeed.length} wallet records...`);

  try {
    for (const box of walletBoxesToSeed) {
      // Input sanitization check
      if (!box.id || !box.publicKey || !box.secretKey) {
        console.warn(`[Seeder WARNING] Skipping incomplete box definition structural template:`, box.id || 'Unknown ID');
        continue;
      }

      WalletManager.registerWallet(db, {
        id: box.id,
        publicKey: box.publicKey,
        secretKey: box.secretKey,
        label: box.label,
        chatId: box.chatId
      });
    }

    console.log('[Seeder SUCCESS] All target metrics and keys synced cleanly into persistent SQLite tables.');
    
    // Quick validation readout
    const currentWallets = WalletManager.getActiveWallets(db);
    console.log(`[Seeder INFO] System Verify: ${currentWallets.length} active wallets currently live inside the database.`);

  } catch (error) {
    console.error('[Seeder CRITICAL ERROR] Database seeding operations failed:', error.message);
  } finally {
    try {
      db.close();
      console.log('[Seeder INFO] Database channel safely closed.');
    } catch (e) {
      console.error('[Seeder ERROR] Failed closing database channel:', e.message);
    }
  }
}

runSeeder();
