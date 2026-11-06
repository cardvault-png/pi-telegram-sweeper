'use strict';

require('dotenv').config();
const StellarSdk = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Pi Network';
const DESTINATION = process.env.SWEEP_DESTINATION_ADDRESS;

async function verifyNetworkConnectivity() {
  console.log(`[Test INFO] Initializing handshake request to endpoint: ${HORIZON_URL}`);
  const server = new StellarSdk.Horizon.Server(HORIZON_URL);

  try {
    const networkMetadata = await server.root();
    
    console.log('\n================ NETWORK VALIDATION METRICS ================');
    console.log(`📡 Horizon Node Status : ONLINE`);
    console.log(`🛠️ Core Engine Version : ${networkMetadata.core_version}`);
    console.log(`⛓️ Ingest Ledger Index : ${networkMetadata.ingest_latest_ledger}`);
    console.log(`⚙️ Protocol Version    : ${networkMetadata.current_protocol_version}`);
    console.log(`🌍 Endpoint Passphrase : ${networkMetadata.network_passphrase}`);
    console.log('============================================================\n');

    if (networkMetadata.network_passphrase !== NETWORK_PASSPHRASE) {
      console.warn(`[Test WARNING] Mismatch detected. Local PASSPHRASE is "${NETWORK_PASSPHRASE}", but the node returned "${networkMetadata.network_passphrase}".`);
    } else {
      console.log(`[Test SUCCESS] Network Passphrase string verification matches: "${NETWORK_PASSPHRASE}"`);
    }

    if (!DESTINATION) {
      console.error('[Test ERROR] SWEEP_DESTINATION_ADDRESS configuration is completely empty.');
    } else {
      try {
        StellarSdk.StrKey.decodeEd25519PublicKey(DESTINATION);
        console.log(`[Test SUCCESS] Destination Routing Format Check Passed: "${DESTINATION}"`);
      } catch (keyError) {
        console.error(`[Test ERROR] SWEEP_DESTINATION_ADDRESS is invalid. Ed25519 format error:`, keyError.message);
      }
    }

  } catch (error) {
    console.error('\n[Test CRITICAL FAILURE] Remote Horizon API endpoint connection handshake failed completely.');
    console.error(`Reason/Error Details: ${error.message}`);
    process.exit(1);
  }
}

verifyNetworkConnectivity();
