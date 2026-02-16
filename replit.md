# Trading Intelligence Engine

## Overview
Analysis-only trading intelligence platform that scans markets using Twelve Data API, detects trading setups via configurable strategies, and sends email alerts.

## Architecture
- **Frontend**: React + Vite + TypeScript, Shadcn UI components, TradingView Lightweight Charts
- **Backend**: Express.js + TypeScript
- **Database**: PostgreSQL via Drizzle ORM
- **Market Data**: Twelve Data API (REST)
- **Alerting**: Nodemailer (SMTP)
- **Background Scanner**: In-process setInterval-based scheduler

## Key Files
- `shared/schema.ts` - Data models (instruments, candles, indicators, signals, scan_runs, alert_events, settings)
- `server/routes.ts` - API endpoints
- `server/storage.ts` - Database operations (IStorage interface + DatabaseStorage)
- `server/twelvedata.ts` - Twelve Data API client with rate limiting
- `server/strategies.ts` - Trading strategy evaluation (TREND_CONTINUATION, RANGE_BREAKOUT)
- `server/scanner.ts` - Background scanner loop
- `server/alerter.ts` - Email alert system
- `server/db.ts` - Database connection pool

## Pages
- `/` - Dashboard (stats, recent signals, scan runs)
- `/signals` - Signal table with filters
- `/instruments` - Instrument whitelist by asset class
- `/instruments/:symbol` - Symbol detail with chart + indicators
- `/settings` - Scanner and email configuration

## API Routes
- `GET /api/instruments` - List all instruments
- `POST /api/instruments/seed` - Seed whitelist
- `GET /api/candles?symbol=X&tf=15m` - Get candles
- `GET /api/indicators?symbol=X&tf=15m` - Get indicators
- `GET /api/signals?strategy=X&direction=X&status=X&symbol=X` - Get signals
- `POST /api/scan/run` - Trigger manual scan
- `GET /api/scan/status` - Scanner status
- `GET /api/scan/runs` - Recent scan runs
- `GET /api/settings` - Get settings
- `POST /api/settings` - Update settings
- `GET /api/dashboard/stats` - Dashboard statistics

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection (auto-provided)
- `TWELVEDATA_API_KEY` - Twelve Data API key (required)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` - Email (optional)
- `SMTP_FROM_EMAIL`, `ALERT_TO_EMAIL` - Email addresses (optional)
- `SESSION_SECRET` - Session secret

## Trading Universe
- 28 Forex pairs, 2 Metals (XAU/USD, XAG/USD), 8 Crypto pairs
- Symbols normalized: canonical (EURUSD) -> vendor (EUR/USD), all asset classes use plain pair format

## Strategies
1. **TREND_CONTINUATION** - Uses 1h bias (EMA200 slope) + 15m entry (EMA stack, pullback, MACD, ADX>=18)
2. **RANGE_BREAKOUT** - ADX<=18, narrow BB width, breakout above/below range with BB confirmation
