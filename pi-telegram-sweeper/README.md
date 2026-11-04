# Pi Telegram Wallet Monitor

This ZIP is a persistent **public-address monitor** for Railway. It includes:
- `/add G...` to register a public wallet address
- `/status` to list registered wallets and last observed native balance
- `/remove ID` to stop monitoring one wallet
- SQLite persistence, suitable for a Railway Volume
- configurable polling interval (minimum 5 seconds)
- Telegram alerts for observed increases in native balance

## Important: the coin remover / Pi lockup Move

The project includes `coin-remover.js` as the lockup adapter boundary. It does **not** pretend to execute Pi Browser's Move action. The public account balance endpoint is not evidence that a lockup expired, and this project has no verified documented external API to invoke that wallet UI action. The `moveLockedPi()` function therefore fails closed instead of inventing an API or risking your Pi.

Likewise, the bot does not accept recovery phrases or secret keys and does not silently transfer funds. A real outgoing transaction needs a supported Pi authorization/signing flow and confirmation from the network. This is not a completed automatic sweeper.

## Railway deployment

1. Upload this ZIP to your GitHub repository and deploy it as a Node service on Railway.
2. Add a Railway Volume to the bot service and mount it at `/data`.
3. In Railway Variables, set:
   - `TELEGRAM_BOT_TOKEN` = your Telegram bot token
   - `PI_HORIZON_URL` = the verified Pi Mainnet Horizon base URL from current Pi documentation
   - `DATA_DIR` = `/data`
   - `POLL_INTERVAL_MS` = `10000`
   - optionally `ALLOWED_TELEGRAM_IDS` = your numeric Telegram user ID
4. Start command: `npm start`.

Do not commit `.env` or share your Telegram token, wallet passphrase, or secret key.

## Local test

```sh
cp .env.example .env
npm install
npm start
```

Open Telegram and send `/start`, then `/add G...PUBLIC_ADDRESS`.

## Notes

- First balance poll establishes a baseline; later increases trigger alerts.
- Balance increases are net balance changes, not a transaction-by-transaction attribution.
- The watcher polls the configured Horizon endpoint. It cannot guarantee millisecond detection.
- Keep the Railway Volume attached. Without persistent storage, registered wallet records can be lost on redeploy.
- Confirm the Horizon URL and network passphrase/endpoint against Pi's current official developer documentation before deployment.
