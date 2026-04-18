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
- `/signals` - Signal table with filters (defaults to Active Only, position sizing in expanded detail)
- `/instruments` - Instrument whitelist by asset class
- `/instruments/:symbol` - Symbol detail with chart + indicators
- `/backtest` - Backtest statistics and archived signal outcomes (position sizing inline)
- `/advisor` - AI Technical Advisor (Portfolio Intelligence, Trade Deep Dive with 1m candles + batch, Strategy Masterclass, Strategy Optimizer)
- `/settings` - Scanner, risk management (account balance, risk %), and email configuration

## API Routes
- `GET /api/instruments` - List all instruments
- `POST /api/instruments/seed` - Seed whitelist
- `GET /api/candles?symbol=X&tf=15m` - Get candles
- `GET /api/indicators?symbol=X&tf=15m` - Get indicators
- `GET /api/signals?strategy=X&direction=X&status=X&symbol=X` - Get signals
- `POST /api/signals/:id/action` - Mark signal TAKEN/NOT_TAKEN (body: { action })
- `POST /api/scan/run` - Trigger manual scan
- `GET /api/scan/status` - Scanner status
- `GET /api/scan/runs` - Recent scan runs
- `GET /api/backtest/signals?strategy=X&direction=X&outcome=X` - Archived signals
- `GET /api/backtest/stats` - Backtest statistics (win rates, by strategy/direction)
- `GET /api/settings` - Get settings
- `POST /api/settings` - Update settings
- `GET /api/dashboard/stats` - Dashboard statistics
- `POST /api/advisor/portfolio-analysis` - AI portfolio-wide pattern analysis
- `POST /api/advisor/trade-analysis` - AI deep dive on single signal (body: { signalId })
- `POST /api/advisor/batch-analyze` - Batch deep dive on multiple signals (body: { signalIds[] })
- `GET /api/advisor/analyzed-signals` - List signal IDs that have stored analyses
- `GET /api/advisor/trade-analysis/:signalId` - Get stored analysis for a signal
- `POST /api/advisor/strategy-guide` - AI strategy masterclass (body: { strategy })
- `POST /api/advisor/strategy-optimizer` - AI strategy optimizer recommendations

## Environment Variables
- `DATABASE_URL` - PostgreSQL connection (auto-provided)
- `TWELVEDATA_API_KEY` - Twelve Data API key (required)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` - Email (optional)
- `SMTP_FROM_EMAIL`, `ALERT_TO_EMAIL` - Email addresses (optional)
- `SESSION_SECRET` - Session secret
- `AI_INTEGRATIONS_OPENAI_API_KEY` - OpenAI via Replit AI Integrations (auto-managed)
- `AI_INTEGRATIONS_OPENAI_BASE_URL` - OpenAI base URL (auto-managed)

## Trading Universe
- 28 Forex pairs, 2 Metals (XAU/USD, XAG/USD), 8 Crypto pairs
- Symbols normalized: canonical (EURUSD) -> vendor (EUR/USD), all asset classes use plain pair format

## Strategies
1. **TREND_CONTINUATION** - Uses 1h bias (EMA200 slope) + 15m entry (EMA stack, pullback, MACD, ADX>=18)
2. **RANGE_BREAKOUT** - ADX<=18, narrow BB width, breakout above/below range with BB confirmation

## Signal Lifecycle
- **status**: NEW (default) → ALERTED (email sent) → EXPIRED (scanner gave up) | TAKEN | NOT_TAKEN (user actions)
- **outcome**: NULL → WIN | LOSS | MISSED (only set by scanner from price action)
- Each scanner tick runs `runScanCycle` first (fresh candles), then `resolveActiveSignals` (TP/SL hits become WIN/LOSS, status preserved for TAKEN/NOT_TAKEN), then `expireOldSignals` (past `signalEvalWindowHours` window → MISSED).
- User TAKEN/NOT_TAKEN: records the decision via `markSignalAction`. Outcome stays NULL until price hits TP/SL or the window elapses, so "Your Win Rate" reflects real resolutions.
- `getUnresolvedSignals` is the union of NEW/ALERTED + TAKEN/NOT_TAKEN with NULL outcome — these are what the scanner monitors each tick.
- Backtest win rate = wins / (wins + losses); MISSED is excluded from the denominator and shown separately.
