# Bot Deployment (DigitalOcean)

## 1) Create VPS
- Ubuntu 22.04 LTS
- $5–$6/mo droplet is fine

## 2) SSH + basic setup
```bash
ssh root@YOUR_SERVER_IP
adduser bot
usermod -aG sudo bot
```

## 3) Install runtime
```bash
apt update
apt install -y python3 git
```

## 4) Clone repo
```bash
sudo -iu bot
git clone https://github.com/YOUR_ORG/polywhaler.git
cd polywhaler
```

## 5) Create bot env file
```bash
mkdir -p bot
nano bot/.env
```
Example:
```
BOT_BASE_URL=https://tanstack-start-app.glc3344.workers.dev
BOT_API_KEY=...
BOT_MIN_GRADE=A
BOT_WINDOW_MINUTES=5
BOT_POLL_SECONDS=20
BOT_MAX_BETS=5
BOT_DRY_RUN=true
BOT_PAPER_BANKROLL=1000
BOT_KELLY_FRACTION=0.25
BOT_MAX_STAKE=50
BOT_TRADE_LOG=/home/bot/polywhaler/bot/trades.jsonl
BOT_STATE_PATH=/home/bot/polywhaler/bot/state.json
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_API_PASSPHRASE=...
POLY_PRIVATE_KEY=...
POLY_FUNDER=...
POLY_SIGNATURE_TYPE=0
POLY_CHAIN_ID=137
POLY_CLOB_HOST=https://clob.polymarket.com
```

## 6) Install systemd service
Copy `bot/polywhaler-bot.service` to `/etc/systemd/system/polywhaler-bot.service`:
```bash
sudo cp bot/polywhaler-bot.service /etc/systemd/system/polywhaler-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now polywhaler-bot
```

## 7) View logs
```bash
journalctl -u polywhaler-bot -f
```

## 8) Update bot
```bash
sudo systemctl stop polywhaler-bot
cd /home/bot/polywhaler
git pull
sudo systemctl start polywhaler-bot
```
