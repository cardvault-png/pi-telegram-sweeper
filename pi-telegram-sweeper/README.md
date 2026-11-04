# Ultimate Multi-Wallet Hyper-Sweeper & Telegram Monitor

A 24/7 persistent backend service designed to manage multiple independent wallet boxes simultaneously with real Stellar SDK cryptographic transaction signing and broadcasting.

## Features
- **Multi-Wallet Box Support:** Register multiple secret keys (`/add G... S...`), tracking each wallet in its own dedicated status box.
- **Millisecond Hyper-Sweeping:** Runs on an aggressive 1-second background loop. Automatically signs and broadcasts transfers using the stored secret key to your configured `SWEEP_DESTINATION_ADDRESS`.
- **Separate Removal Alert Boxes:** Pushes a dedicated confirmation alert the exact millisecond coins are swept.
