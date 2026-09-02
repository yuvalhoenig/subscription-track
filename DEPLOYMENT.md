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

### 2.1 Generate the secrets first

Open a terminal on your Mac (not the app repo, doesn't matter where) and run
these three commands one at a time. Copy each output somewhere temporary
(a Notes doc, a scratch text file) — you'll paste them into Vercel in a
minute.

```
openssl rand -hex 48
```
Copy this output. Label it `JWT_ACCESS_SECRET`.

```
openssl rand -hex 48
```
Run it **again** — it must be a different value. Label it `JWT_REFRESH_SECRET`.

```
openssl rand -hex 32
```
Copy this one too. Label it `CRON_SECRET`.

### 2.2 Import the project

1. Go to **https://vercel.com/new** in your browser. Log in with GitHub if
   it asks (use the same GitHub account that owns `yuvalhoenig/subscription-track`).
2. You'll see a list of your GitHub repos under **"Import Git Repository."**
   Find `subscription-track` in the list and click the **Import** button
   next to it.
   - If you don't see it, click **"Adjust GitHub App Permissions"** (a link
     usually shown above or below the list) and grant Vercel access to that
     repo specifically, then come back to this page.
3. You land on a **"Configure Project"** screen. Set these fields:
   - **Project Name**: type `subtrack-api` (this becomes part of the URL:
     `subtrack-api.vercel.app` — if that name is taken, Vercel will tell you
     and suggest a variant; whatever it ends up being, remember it).
   - **Framework Preset**: click the dropdown and pick **"Other"**.
   - **Root Directory**: click **Edit** next to it, a file-tree picker opens.
     Click into `packages`, then click into `server`, then click **Continue**
     (or **Select**) so the field shows `packages/server`.
   - Leave **Build and Output Settings** collapsed/default — don't touch it.
4. Before clicking Deploy, expand the **"Environment Variables"** section on
   that same screen (it's a collapsible panel further down the page). Add
   each row below one at a time: type the key into the left box, the value
   into the right box, then click **Add** (or press Enter) before starting
   the next one.

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Supabase's **pooled** connection string (port `6543`) — see step 1.2. It looks like `postgresql://postgres.xxxxxxxx:<password>@aws-0-xx-xxxx-1.pooler.supabase.com:6543/postgres` |
   | `PGSSLMODE` | `require` |
   | `JWT_ACCESS_SECRET` | the first value you generated above |
   | `JWT_REFRESH_SECRET` | the second value you generated above |
   | `CRON_SECRET` | the third value you generated above |
   | `APP_URL` | `https://subtrack-web.vercel.app` (a placeholder — you'll fix this for real in step 3.5, once the web project actually exists) |
   | `CORS_ORIGINS` | same value as `APP_URL` above |
   | `REDIS_ENABLED` | `false` |
   | `NODE_ENV` | `production` |
   | `ANTHROPIC_API_KEY` | your Claude API key from **https://console.anthropic.com/settings/keys**, if you have one — optional, skip this row entirely if you don't. Without it, AI features (chat, insights, categorisation) still work but use rule-based logic instead of Claude. |

   Every field defaults to applying to **Production, Preview, and
   Development** — that's fine, leave it as-is.
5. Click the big **Deploy** button at the bottom.
6. Wait for the build to finish — you'll see a log stream, then a
   confetti/"Congratulations" screen with a screenshot preview. This
   usually takes 30–90 seconds.

### 2.3 Find the project's URL and verify it

1. Click **"Continue to Dashboard"** (or click the project name at the top).
2. On the project's overview page, near the top, there's a row of small
   links/domains — one will look like `subtrack-api.vercel.app` (or
   `subtrack-api-<random>.vercel.app` if the plain name was taken). Click
   the copy icon next to it, or just click it to open it in a new tab.
3. **Write this URL down** — you need it for step 3. Call it your **API URL**.
4. Test it actually works: in your terminal, run (replacing with your real URL):
   ```
   curl https://subtrack-api.vercel.app/api/health
   ```
   You should get back something like:
   ```
   {"status":"ok","database":true,"cache":"memory","ai":"heuristic","uptimeSeconds":0,"timestamp":"..."}
   ```
   - `"database":true` means it successfully reached Supabase — if this is
     `false` or the request errors out, your `DATABASE_URL` is wrong; go to
     **Project Settings → Environment Variables**, fix it, then go to the
     **Deployments** tab and click **Redeploy** on the latest one (see the
     "⋯" menu next to it).
   - If the whole `curl` fails (connection error, not JSON), the deploy
     itself likely failed — check the **Deployments** tab for a red ✗ and
     click into it to read the build log.

**Why `REDIS_ENABLED=false`:** Redis here only accelerates AI response
caching and rate-limit counters — the app is explicitly designed to fall
back to a per-instance in-memory store when Redis is absent, so this is
safe to skip for launch. The one real cost: rate limits and the AI-per-hour
budget are enforced per serverless instance rather than globally, so they're
softer than on a single long-running server. If that becomes a problem,
Upstash Redis (on the Vercel Marketplace) is a drop-in `REDIS_URL`.

---

## 3. Vercel — the web app

### 3.1 Point the web app's proxy at your real API URL first

This has to happen **before** you deploy the web project, because it's a
file in the repo, not a dashboard setting.

1. On your Mac, in your terminal, `cd` into the repo (the one you cloned
   earlier) and open the file in a text editor:
   ```
   cd subscription-track
   open -e packages/web/vercel.json
   ```
   (`open -e` opens it in TextEdit. Use any editor you like instead — VS
   Code, `nano packages/web/vercel.json`, whatever's easiest.)
2. You'll see this:
   ```json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "rewrites": [
       {
         "source": "/api/(.*)",
         "destination": "https://REPLACE-WITH-YOUR-API-PROJECT.vercel.app/api/$1"
       },
       { "source": "/(.*)", "destination": "/index.html" }
     ]
   }
   ```
3. Replace `REPLACE-WITH-YOUR-API-PROJECT.vercel.app` with your actual API
   URL from step 2.3 (just the domain — keep `https://` and the rest of the
   path exactly as-is). For example, if your API URL is
   `https://subtrack-api.vercel.app`, the line becomes:
   ```json
   "destination": "https://subtrack-api.vercel.app/api/$1"
   ```
4. Save the file, then commit and push it:
   ```
   git add packages/web/vercel.json
   git commit -m "Point web app proxy at the deployed API"
   git push origin claude/subscription-platform-ai-gjdsk0
   ```

### 3.2 Import the project

1. Go to **https://vercel.com/new** again.
2. Find `subscription-track` in the repo list again and click **Import**
   next to it — yes, the same repo again; Vercel lets you create multiple
   projects from one repo, each with its own Root Directory.
3. On the **"Configure Project"** screen:
   - **Project Name**: type `subtrack-web`.
   - **Framework Preset**: it should auto-detect **"Vite"** once you set the
     Root Directory below (do that first, then check this field).
   - **Root Directory**: click **Edit**, navigate into `packages` → `web`,
     click **Continue**/**Select** so it shows `packages/web`.
   - **Build and Output Settings**: leave on default (Vercel will use
     `npm run build` and output directory `dist` automatically once it
     detects Vite — you don't need to type anything here).

### 3.3 Environment variables (there's only one, and it's optional to skip)

Expand **"Environment Variables"** on the same screen. You do **not** need
to add `VITE_API_URL` — leave it out entirely. The app calls `/api/...` as
a relative path in production, and the `vercel.json` rewrite you just
committed sends that to your API project. (`VITE_API_URL` only matters for
local dev on your Mac, where it's already set up separately.)

Skip this section and go straight to Deploy.

### 3.4 Deploy and find its URL

1. Click **Deploy**. Wait for the build (Vite builds are usually fast, under
   a minute).
2. Same as before: click **"Continue to Dashboard"**, find the domain near
   the top of the project page (e.g. `subtrack-web.vercel.app`), and open it
   in a new tab to confirm the SubTrack login page loads.
3. **Write this URL down** too — call it your **web URL**.

### 3.5 Go back and fix the API project's placeholder URL

Step 2.2 set `APP_URL` and `CORS_ORIGINS` on the API project to a guessed
placeholder, before the web project existed. Now that you have the real
web URL, fix it:

1. Go to **https://vercel.com/dashboard**, click into the **`subtrack-api`**
   project (not the web one).
2. Click the **Settings** tab (top nav inside the project), then
   **Environment Variables** in the left sidebar.
3. Find the row for `APP_URL`. Click the **"⋯"** (three dots) at the right
   end of that row, choose **Edit**, clear the value box, type in your real
   web URL from step 3.4 (e.g. `https://subtrack-web.vercel.app`), and save.
4. Do the exact same thing for the `CORS_ORIGINS` row — same value.
5. These changes don't apply to the already-running deployment automatically
   — you have to redeploy. Click the **Deployments** tab, find the most
   recent (top) row, click its **"⋯"** menu, and choose **Redeploy**. Confirm
   in the dialog that pops up. Wait for it to finish (green checkmark).

### 3.6 Log in

Open your web URL in a browser and sign in with the admin account you
created in step 1.4 (`yuvalhoenig15@gmail.com` / `A1a2a3a4a6!`). You should
land on the dashboard and see **"Admin Panel"** in the sidebar.

If login fails with a network error rather than a "wrong password" message,
the most likely cause is the proxy in step 3.1 pointing at the wrong API
domain — double check `packages/web/vercel.json` matches your actual API
URL exactly, redeploy the web project if you change it (Deployments tab →
⋯ → Redeploy, same as 3.5.5), and check the browser's dev tools Network tab
(F12 → Network) for what URL the failing request actually went to.

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
