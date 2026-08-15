# 🧠 Sanctum

An agentic second brain that **grows with you**. Dump anything → an extraction agent builds a linked memory graph automatically → chat with an assistant that knows you better every conversation.

## Stack
- **Next.js** (full-stack: UI + API routes) · **Tailwind CSS** · **Ant Design**
- **Prisma ORM** — typed client for all queries. DDL stays SQL-owned (`db/migrations/*.sql`, auto-applied on dev start) because Prisma can't manage pgvector columns; embeddings are written via raw SQL. After schema changes: mirror in `prisma/schema.prisma` + `npx prisma generate`
- **Neon Postgres + pgvector** — memory graph (`dumps` / `nodes` / `edges`) + semantic search
- **Azure Foundry** — `FW-Kimi-K3` (chat/extraction) + `text-embedding-3-large` @ 1536 dims (embeddings)
- **The brain is markdown** — behavior lives in `brain/*.md`, editable without redeploys

## Setup
```bash
npm install          # postinstall runs prisma generate
cp .env.example .env # fill in AZURE_FOUNDRY_API_KEY + DATABASE_URL (Neon)
npm run dev          # auto-applies db/migrations/*.sql on startup
```

## 🌱 Grows with you
Five feedback loops make every chat improve the next:
1. **Profile** — a pinned node for you (the ☀️ of the cosmos, always in context); preferences, habits and style feedback accrue as dot-key attrs and silently shape every reply
2. **Salience** — memories strengthen when used (mention/recall counts), sink when neglected; recall reranks cosine × salience
3. **Consolidation** — the sleep cycle: `POST /api/admin/consolidate` (dry run) promotes patterns into your profile; `{"apply": true}` also merges duplicates; stale candidates reported
4. **Continuity** — chat history persists server-side (survives refresh; the client sends only the new message); conversations crystallize into `Conversation` digest nodes (auto every 6 exchanges — 12 persisted messages, counted from the DB — + on clear-chat); open loops (unfinished tasks) get natural callbacks
5. **Feedback** — 👍/👎 on replies feeds consolidation; the ✨ Week button shows what it learned

## The loop
1. `POST /api/dump` → Kimi extracts nodes+edges (guided by `brain/extract.md` + `brain/types.md`) → Postgres
2. `POST /api/chat` → profile + open loops + salience-ranked recall → streamed reply; silent memory write never blocks the reply
3. `POST /api/ask` → cited answers from the graph

## Routes
- `/api/chat` · `/api/chat/history` (session rehydration) · `/api/dump` · `/api/ask` · `/api/graph` · `/api/recap` · `/api/feedback`
- `/api/graph/node` — node inspector payload (GET) + explicit forget (POST `{id, action:"forget"}`)
- `/api/conversations/digest` — session-end crystallization (server-side transcript) + session rotation
- `/api/admin/rebuild` (re-extract all dumps) · `/api/admin/consolidate` (sleep cycle: nightly cron = dry-run proposals; `POST {"apply": true}` applies merges) · `/api/admin/export` (full JSON backup)

## Migrations
Schema lives in `db/migrations/`, auto-applied on `npm run dev` (tracked in a `_migrations` table).
To change the schema: add `00X_your_change.sql` → runs on next dev start. Never edit applied files.
Note: `npm run build` no longer migrates (DDL against prod mid-build was risky) — run `npm run db:migrate` before deploying schema changes.

## Smoke test
With the dev server up: `node scripts/test-growth.mjs` — verifies profile seeding, attr accrual and recall end-to-end.
