# Bot Service (Python)

Minimal polling bot that calls the app's bot API and places bets.

## Setup
- Set env vars:
  - `BOT_BASE_URL` (e.g. https://your-domain)
  - `BOT_API_KEY`
  - `BOT_MIN_GRADE` (default A)
  - `BOT_WINDOW_MINUTES` (default 5)
  - `BOT_POLL_SECONDS` (default 20)
  - `BOT_DRY_RUN` (default true)
  - `BOT_MAX_BETS` (default 5)
  - `BOT_PAPER_BANKROLL` (default 1000)
  - `BOT_KELLY_FRACTION` (default 0.25)
  - `BOT_MAX_STAKE` (default 50)
  - `BOT_MIN_STAKE` (default 1)
  - `BOT_FIXED_STAKE` (default 0, set to force a fixed stake per bet)
  - `BOT_LOW_ROI_THRESHOLD` (default 0.72, skip if price >= threshold)
  - `BOT_STOP_ON_403` (default true, exit on Cloudflare 403)
  - `BOT_POLL_JITTER` (default 0.2, adds +/- jitter to polling)
  - `BOT_POLL_BACKOFF_BASE` (default 2, seconds)
  - `BOT_POLL_BACKOFF_MAX` (default 120, seconds)
  - `BOT_MAX_CALLS_PER_HOUR` (default 120)
  - `BOT_RUN_WINDOW_START` (optional, e.g. 17:00)
  - `BOT_RUN_WINDOW_END` (optional, e.g. 23:00)
  - `BOT_RUN_WINDOW_TZ` (default America/New_York)
  - `BOT_PLACED_TTL_SECONDS` (default 21600, fallback dedupe TTL when eventTime is missing)
  - `BOT_PLACED_EVENT_GRACE_SECONDS` (default 1800, keep dedupe until eventTime + grace)
  - `BOT_TRADE_LOG` (default bot/trades.jsonl)
  - `BOT_PREFLIGHT` (set true to validate CLOB creds and exit)
  - `BOT_PREFLIGHT_CONDITION_ID` (optional: validates token-id resolution + midpoint)
  - `POLY_USDC_TOKEN` (default 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174)
  - `POLY_CONDITIONAL_TOKEN` (default 0x4D97DCd97eC945f40cF65F87097ACe5EA0476045)
  - `POLY_API_KEY` (optional, CLOB API creds)
  - `POLY_API_SECRET` (optional, CLOB API creds)
  - `POLY_API_PASSPHRASE` (optional, CLOB API creds)
  - `POLY_PRIVATE_KEY` (required for live trading)
  - `POLY_FUNDER` (required if using Magic/email or proxy wallet signatures)
  - `POLY_SIGNATURE_TYPE` (0=EOA, 1=Magic/email, 2=proxy; default 0)
  - `POLY_CHAIN_ID` (default 137)
  - `POLY_CLOB_HOST` (default https://clob.polymarket.com)

Alternatively, create `bot/.env` with the same keys. `bot/bot.py` will auto-load it.

## Run
```bash
python bot/bot.py
```

## Notes
- Install the trading client if you want live orders:
  ```bash
  pip install py-clob-client
  ```
- Live trading uses the Polymarket CLOB client when `BOT_DRY_RUN=false`.
- The bot writes a local `bot/state.json` file for idempotency.

## Control Agent (systemd/journalctl API)
To manage the bot from the `/bot` page in the Cloudflare app, run the lightweight
control agent on the VPS and expose it via Cloudflare Tunnel.

1. Copy the agent to the VPS:
   ```bash
   scp bot/control-agent.py root@your-vps:/root/polywhaler/bot/control-agent.py
   ```
2. Install the systemd unit:
   ```bash
   scp bot/control-agent.service root@your-vps:/etc/systemd/system/polywhaler-control-agent.service
   ```
3. Edit the unit to set `CONTROL_TOKEN` and allowed env keys, then:
   ```bash
   systemctl daemon-reload
   systemctl enable --now polywhaler-control-agent
   ```

### Cloudflare Tunnel (recommended)
- Bind the agent to `127.0.0.1` only (default).
- Create a tunnel for `http://127.0.0.1:9102` and protect it with Cloudflare Access.
- In the Cloudflare app, set:
  - `BOT_CONTROL_URL` to the tunnel hostname (e.g. `https://bot-control.example.com`)
  - `BOT_CONTROL_TOKEN` to the same `CONTROL_TOKEN`
  - `BOT_CONTROL_ACCESS_ID` and `BOT_CONTROL_ACCESS_SECRET` to your Access service token
