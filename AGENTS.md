# AGENTS.md

High-signal context for AI agents working in this repo (Pinote by Contrivent — meeting transcript app). Verify against the code before trusting anything below.

## Toolchain truth (don't get fooled)

- Root `package.json` scripts are thin wrappers using `npm --prefix backend` / `npm --prefix frontend`. **Use npm, not pnpm**, even though a stale `pnpm-lock.yaml` sits at the root. Each app has its own `package-lock.json`.
- Two deployable processes live in the **same** `backend` package, with separate entry points: API = `src/index.ts`, worker = `src/worker.ts`. Both run as PM2 processes (`app`, `worker`) on a VPS.
- There is **no test runner, lint, or formatter configured**. Don't invent `npm test` / `npm run lint`. Verification = `npm --prefix backend run build` (= `tsc`) and `npm --prefix frontend run build` (= `tsc -b && vite build`). Typecheck by building.
- Backend is ESM (`"type": "module"`). TS source **must use explicit `.js` import specifiers** (e.g. `./routes/auth.js`) because `moduleResolution: Bundler` + runtime ESM. Match this style in any new file.

## Stack (post-Supabase migration)

- **Infra: full Supabase.** Postgres + Storage (S3-compatible). No Neon, no Cloudflare R2, no Upstash Redis.
- **DB driver: `postgres` (postgres-js)** via `drizzle-orm/postgres-js`. `db/client.ts` disables prepared statements (`prepare: false`) so it works against the Supabase transaction-mode pooler (port 6543). `db/migrate.ts` uses the same driver + `drizzle-orm/postgres-js/migrator`.
- **No Redis.** What used to live in Upstash (job progress, user stats, worker heartbeat, login rate-limit counters) now lives in the `cache_entries` Postgres table (generic key/value with TTL via `expires_at`). All access goes through `services/cache.ts`. The `/health` check field is named `cache` (not `redis`).
- **Summary provider: GLM** (Zhipu / z.ai, OpenAI-compatible). Called from `services/deepgram.ts` via the `openai` SDK pointed at `GLM_BASE_URL` (default `https://api.z.ai/api/paas/v4`) with model `GLM_MODEL` (default `glm-5.2`). `services/openai.ts` and `services/gemini.ts` were deleted (legacy, not on the active path).

## Commands

Run from repo root:

```bash
npm --prefix backend run dev            # API (tsx watch src/index.ts)
npm --prefix backend run dev:worker     # worker (requires STORAGE_PROVIDER=s3)
npm --prefix frontend run dev           # Vite on :5173

npm --prefix backend run build          # tsc -> dist/
npm --prefix frontend run build

npm --prefix backend run db:generate    # drizzle-kit generate from src/db/schema.ts
npm --prefix backend run db:migrate     # tsx src/db/migrate.ts (needs DATABASE_URL)
npm --prefix backend run db:seed        # tsx src/db/seed.ts
npm --prefix backend run db:studio      # drizzle-kit studio
```

Before deploy, run `node dist/db/migrate.js && node dist/db/seed.js` — so any DB code touched by migrations/seed must compile into `dist/` (it does via `rootDir: src`).

## Architecture gotchas

- **Active transcription provider = Deepgram only**, via `backend/src/services/deepgram.ts`, called from `services/transcription.ts`. The Deepgram module also generates the meeting summary by calling GLM (not OpenAI). `services/openai.ts`, `services/gemini.ts`, and `lib/prompts.ts` were **deleted** as legacy. Don't "switch providers" without rewiring `transcription.ts`.
- Worker refuses to start unless `STORAGE_PROVIDER=s3` is set (`worker.ts` throws). Local dev without S3 = the API handles uploads via the in-process fallback, and jobs **will not get transcribed** because the worker won't boot. Local full-flow testing requires Supabase Storage configured.
- Job lifecycle is DB-driven, not queue-driven: statuses `uploading -> queued -> transcribing -> completed|failed|cancelled`. Worker claims via `UPDATE ... WHERE status='queued'` (no message broker). `index.ts` reclaims `uploading` jobs on API restart; `worker.ts` re-queues `transcribing` jobs with a `storageKey` on worker restart.
- Credits are reserved upfront using client-sent `durationSec`, then reconciled by the worker against Deepgram's real duration. Cancel = soft cancel + refund. See `services/transcription.ts`.
- Public share: `/share/:token` is rendered by the **backend as HTML** (server-side, for crawlers/AI). The frontend SPA must NOT swallow this path — `vercel.json` rewrites `/share/:token` to the backend before the SPA fallback. Keep that rewrite if touching routing.
- `/health` is the readiness check; it reports `degraded` (503) if db/cache/storage/worker-heartbeat fail. `/health/live` is liveness-only (always 200). The health field is `cache` (not `redis`).

## Env (common mistakes)

- `.env.example` at root documents both backend and frontend vars. Backend reads from `backend/.env`; frontend reads from `frontend/.env` and only exposes `VITE_*`.
- These names are **documented as targets but NOT read by current code** — do not assume they work: `JWT_SECRET`, `COOKIE_SECRET`, `REDIS_URL`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `FRONTEND_ORIGIN`, `TRANSCRIPTION_PROVIDER`, `OPENAI_API_KEY`. Active Redis-replacement = `cache_entries` table (no env). Active summary = `GLM_API_KEY` + `GLM_BASE_URL` + `GLM_MODEL`.
- Supabase Storage via S3-compatible API: `S3_ENDPOINT=https://[ref].supabase.co/storage/v1/s3`, `S3_FORCE_PATH_STYLE=false`. S3 creds come from Project Settings > Storage > S3 Connection (not the standard Supabase service-role key).
- CORS is `ALLOWED_ORIGINS` (comma-separated). `credentials: true` is on, so origin must match exactly or browsers will block credentialed requests.
- Seed refuses weak admin passwords in staging/prod (`DEFAULT_ADMIN_PASSWORD` must be ≥ 8 chars).

## Style / conventions

- Backend code keeps Bahasa Indonesia strings in user-facing error messages (e.g. upload failure messages in `index.ts`). Preserve that when editing user-visible strings.
- All schema changes start in `backend/src/db/schema.ts`, then `db:generate` to emit SQL into `src/db/migrations/`. Don't hand-edit generated migration SQL for normal changes.
- Frontend is mobile-first + PWA; `vite-plugin-pwa` config in `vite.config.ts` may hardcode an old API origin in the runtime cache rule — note if touching API hosting.
