# Ultimate Multi-Wallet Hyper-Sweeper & Telegram Monitor

A 24/7 persistent backend service designed to manage multiple independent wallet boxes simultaneously. 

## Key Features
- **Multi-Wallet Box Support:** Register multiple passphrases/secret keys (`/add G... S...`), tracking each wallet in its own dedicated status box.
- **Initial Balance & Real-Time Inspection:** Immediately reports the starting coin balance upon registration and continuously counts inspection ticks.
- **Millisecond Hyper-Sweeping:** Runs on an aggressive 1-second background loop. The moment any coin drops, is transferred in, or matures from lockups, it is instantly swept out to your designated destination address.
- **Separate Removal Alert Boxes:** Whenever coins are swept or removed from any wallet, the bot sends a dedicated, distinct alert notification detailing the exact amount removed and destination.
- **Persistent 24/7 Uptime:** Continues running independently on Railway even if your phone or Telegram is shut down.
