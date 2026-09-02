# Deploying SubTrack: Vercel + Supabase

This deploys the API and the web app as two Vercel projects (from the same
GitHub repo) backed by a Supabase Postgres database. Nothing here needs a
server you manage — everything is click-through in the Vercel and Supabase
dashboards, using the config files already committed at
`packages/server/vercel.json` and `packages/web/vercel.json`.

Total order matters: database first, then the API (it needs the database),
then the web app (it needs the API's URL).

---

## 1. Supabase — the database

1. Create a project at [supabase.com](https://supabase.com/dashboard) — pick
   any name/region, and **write down the database password** you set; it's
   only shown once.
2. In the project, go to **Project Settings → Database → Connection string**.
   You need two different connection strings from here:
   - **Direct connection** (port `5432`, host `db.<project-ref>.supabase.co`)
     — used once, right now, to run migrations.
   - **Transaction pooler** (port `6543`, host
     `aws-<region>.pooler.supabase.com`, username
     `postgres.<project-ref>`) — this is the one the deployed API uses at
     runtime. Serverless functions open and close connections constantly;
     the pooler is built for exactly that, where a direct connection to
     Postgres would run out of slots under real traffic.
3. Run the migration from your machine, against the **direct** connection
   string:
   ```
   cd subscription-track
   DATABASE_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
   PGSSLMODE=require \
   npm run db:migrate --workspace=packages/server
   ```
   You should see every file under `packages/server/src/db/migrations`
   listed as applied. (Skip `npm run db:seed` — that inserts fake demo data;
   you don't want that in your real database.)
4. Create your own account: register normally once the web app is live
   (step 3 below), or do it now directly against Supabase:
   ```
   DATABASE_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres" \
   PGSSLMODE=require \
   npm run admin:create --workspace=packages/server -- yuvalhoenig15@gmail.com 'A1a2a3a4a6!' Yuval
   ```

Keep both connection strings — the direct one for any future migration, the
pooled one for the Vercel env var below.

---

## 2. Vercel — the API

1. [Import the repo](https://vercel.com/new) as a **new project**. When
   asked for the **Root Directory**, choose `packages/server`. Framework
   preset: **Other**.
2. Under **Environment Variables**, add (Production, and Preview if you want
   preview deploys to work too):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the **pooled** (port 6543) connection string from Supabase |
   | `PGSSLMODE` | `require` |
   | `JWT_ACCESS_SECRET` | output of `openssl rand -hex 48` |
   | `JWT_REFRESH_SECRET` | a **different** `openssl rand -hex 48` |
   | `CRON_SECRET` | output of `openssl rand -hex 32` |
   | `APP_URL` | the web project's URL (fill in after step 3 — a placeholder is fine for now, e.g. `https://subtrack-web.vercel.app`) |
   | `CORS_ORIGINS` | same URL as `APP_URL` |
   | `ANTHROPIC_API_KEY` | your Claude API key, for real AI features (optional — the app runs on deterministic heuristics without it) |
   | `REDIS_ENABLED` | `false` |
   | `NODE_ENV` | `production` |

   Leave `SMTP_*` unset for now if you don't have a transactional-email
   provider yet — e-mails (verification, password reset, renewal reminders)
   just get logged instead of sent, and nothing else breaks. Add them later
   when you have one (Resend, Postmark, SES all work over standard SMTP).

3. Deploy. Once it's live, note the project's URL — something like
   `https://subtrack-api.vercel.app`.
4. Sanity-check it: `curl https://subtrack-api.vercel.app/api/health` should
   return `{"status":"ok","database":true,...}`.

**Why `REDIS_ENABLED=false`:** Redis here only accelerates AI response
caching and rate-limit counters — the app is explicitly designed to fall
back to a per-instance in-memory store when Redis is absent, so this is
safe to skip for launch. The one real cost: rate limits and the AI-per-hour
budget are enforced per serverless instance rather than globally, so they're
softer than on a single long-running server. If that becomes a problem,
Upstash Redis (on the Vercel Marketplace) is a drop-in `REDIS_URL`.

---

## 3. Vercel — the web app

1. [Import the repo](https://vercel.com/new) again as a **second, separate
   project**. Root Directory: `packages/web`. Framework preset: **Vite**
   (auto-detected).
2. Before deploying, edit `packages/web/vercel.json` in the repo and replace
   `REPLACE-WITH-YOUR-API-PROJECT` with the API project's actual domain from
   step 2 (e.g. `subtrack-api.vercel.app`), then commit and push. This file
   makes `/api/*` on the web app's own domain transparently proxy to the API
   project — the browser only ever talks to one origin, so there's no CORS
   or cross-site-cookie configuration to fight with, and the refresh-token
   cookie works exactly like it does in local dev.
3. Environment variable: leave `VITE_API_URL` **unset** (or empty) in
   production — the app calls `/api/...` as a relative path, which the
   rewrite above sends to your API project. `VITE_API_URL` is only for
   local dev, where Vite's own dev-server proxy plays the same role.
4. Deploy. Once it's live, go back to the **API project's** environment
   variables and set `APP_URL` and `CORS_ORIGINS` to this web app's real
   URL (replacing the placeholder from step 2), then redeploy the API
   project so the change takes effect.
5. Visit the web app's URL and log in with the admin account from step 1.4.

---

## 4. Background jobs (renewal reminders, nightly insights)

The traditional server (`npm start`) runs these itself via an in-process
scheduler. On Vercel there's no long-running process to hold that timer, so
`packages/server/vercel.json` instead defines two
[Cron Jobs](https://vercel.com/docs/cron-jobs) that hit authenticated HTTP
routes on a schedule:

- `/api/cron/notifications` — daily at 13:00 UTC (queues + sends renewal
  reminders and budget alerts)
- `/api/cron/nightly-insights` — daily at 03:00 UTC (recomputes usage
  scores and regenerates AI insights)

Both require the `Authorization: Bearer <CRON_SECRET>` header — Vercel
attaches this automatically once `CRON_SECRET` is set as an environment
variable on the project, using the exact value you set in step 2. No
further setup is needed; cron jobs activate as soon as the project with
that `vercel.json` is deployed.

Both schedules are once-daily because Vercel's **Hobby** plan only allows
one run per day per cron job (more frequent schedules fail to deploy on
Hobby). If you're on a **Pro** plan, you can tighten `notifications` back
to something like `*/15 * * * *` by editing the `crons` array in
`packages/server/vercel.json`, since the original design intent was a
15-minute check for due reminders — daily is an acceptable degradation for
launch, not the ideal cadence.

---

## 5. What's out of scope for this pass

- **Custom domain.** Both projects work fine on their `*.vercel.app`
  domains. Attaching a real domain is a few clicks in each project's
  Settings → Domains whenever you have one.
- **Transactional email.** Verification/reset/reminder e-mails are logged,
  not sent, until `SMTP_*` is configured.
- **Electron desktop app.** It's unrelated to this web deployment; point its
  build at the deployed API URL (`VITE_API_URL` at desktop build time) when
  you're ready to distribute it — this doesn't need Vercel at all.
- **Redis.** See the note in step 2 — safe to skip at this scale, easy to
  add later.
