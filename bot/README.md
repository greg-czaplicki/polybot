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
  - `BOT_TRADE_LOG` (default bot/trades.jsonl)
  - `POLY_API_KEY`
  - `POLY_API_SECRET`
  - `POLY_API_PASSPHRASE`

Alternatively, create `bot/.env` with the same keys. `bot/bot.py` will auto-load it.

## Run
```bash
python bot/bot.py
```

## Notes
- Implement `place_bet` in `bot/bot.py` to use your Polymarket execution logic.
- The bot writes a local `bot/state.json` file for idempotency.
