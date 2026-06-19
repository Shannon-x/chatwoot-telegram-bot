# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a **Chatwoot Telegram Bot Bridge** (`telegram-chatwoot`) — a single-process Node.js/TypeScript middleware that bridges Chatwoot (customer support) and Telegram. It runs an Express webhook server and a Telegraf-based Telegram bot in the same process, using embedded SQLite (`better-sqlite3`) for persistence.

### Running the dev server

```bash
npm run dev
```

This uses `nodemon` + `ts-node` for hot-reload. The Express server starts on port 3000 (configurable via `PORT` in `.env`).

### Key caveats

- **No test suite**: `npm test` is a placeholder that exits with code 1. There are no automated tests to run.
- **No linter configured**: There is no ESLint or Prettier config in the repo. TypeScript compilation (`npm run build`) is the closest thing to a lint step.
- **External credentials required**: The Telegram bot requires a valid `TELEGRAM_TOKEN` to connect. Without real credentials, the bot's `launch()` fails with a 404 error, but the Express webhook server still starts and processes incoming webhooks.
- **SQLite is embedded**: No external database service is needed. The database file is created automatically at `DB_PATH` (defaults to `mappings.db` in the working directory).
- A `.env` file (copied from `.env.example`) is needed for the app to load config. With placeholder values, the webhook server runs but Telegram/Chatwoot API calls will fail.

### Build & verify

```bash
npm run build   # TypeScript compilation — use this as the lint/type-check step
npm run dev     # Start dev server (Express on :3000 + Telegram bot polling)
```

### Testing the webhook endpoint

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"message_created","message_type":"incoming","content":"test","conversation":{"id":1},"account":{"id":1},"sender":{"name":"Test","email":"test@example.com"}}'
```

Expected: HTTP 200 response. The server logs will show it attempted to forward the message to Telegram.
