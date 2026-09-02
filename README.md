# SubTrack

AI-powered subscription management. Track what you pay for, see what it
actually costs you, and get told — in plain English — where the waste is.

Runs as a responsive web app and as a native macOS desktop app, sharing one
API, one database and one AI engine.

```
┌──────────────┐   ┌──────────────────┐
│  Web (React) │   │ Desktop (Electron)│   same React bundle
└──────┬───────┘   └────────┬─────────┘
       └──────────┬─────────┘
            REST + JWT
                  │
        ┌─────────▼──────────┐
        │  API (Express)     │
        │  ├─ AI engine ─────┼──► Claude API
        │  ├─ Analytics / ML │
        │  └─ Jobs (cron)    │
        └────┬──────────┬────┘
             │          │
        PostgreSQL    Redis
                    (optional)
```

---

## Quick start

Requires **Node 20.10+** and **PostgreSQL 14+**. Redis is optional.

```bash
git clone https://github.com/yuvalhoenig/subscription-track.git
cd subscription-track
npm install

cp .env.example .env          # works as-is for local development

docker compose up -d          # Postgres + Redis
# ...or use your own Postgres and set DATABASE_URL

npm run db:migrate
npm run db:seed               # creates the demo account

npm run dev                   # API on :4000, web on :5173
```

Open <http://localhost:5173> and use the **Sign in as demo user** button, or:

| | |
| --- | --- |
| E-mail | `demo@subtrack.app` |
| Password | `DemoPass123!` |

The demo account has 20+ subscriptions, 14 months of payment history, usage
data, and AI insights already generated — enough to exercise every feature.

### It works without an API key

Set `ANTHROPIC_API_KEY` in `.env` for Claude-written insights and full
conversational chat. **Without one, nothing breaks.** Every AI feature has a
deterministic fallback:

| Feature | With Claude | Without |
| --- | --- | --- |
| Add by description | Full NLU | Catalogue + regex extractor |
| Categorisation | Model classification into your own categories | Catalogue lookup, then keyword rules |
| Insights | Written by Claude from computed figures | Templated text from the same figures |
| Assistant | Tool-use conversation | Intent router covering the common questions |
| Receipts / e-mail | Model parsing | Structural parsing (total lines, sender domain) |

The header in the sidebar tells you which mode you are in.

---

## Feature tour

### Subscriptions
Add, edit, pause, cancel or delete. Any billing cycle (weekly through
yearly) is normalised to a monthly and yearly equivalent, so a $100/year
plan and a $8.33/month plan compare directly. Trials are tracked separately
from committed spend and surface before they convert. Price changes are
recorded automatically.

### Dashboard
Monthly and yearly spend, month-over-month movement, budget usage,
category breakdown, spending history, a forecast, upcoming renewals, and
your biggest commitments.

### Renewal calendar
A month grid with per-day totals plus a chronological list. Recurring
charges are expanded per occurrence, so a weekly subscription appears four
or five times in a month.

### AI insights
Five views: the insight feed, savings breakdown, forecast, value ranking,
and a written report.

---

## The AI and analytics engine

The division of labour is deliberate and worth being explicit about:

> **Deterministic code computes every number. Claude only writes the prose.**

The optimiser, forecaster and anomaly detector produce the findings and the
savings figures. Claude turns them into readable cards and prioritises what
to say first. A hallucination can therefore make an insight badly *worded*,
but never numerically wrong — and every insight stays explainable from the
structured `data` payload stored alongside it.

### Cost optimisation
- **Duplicate detection** — the same vendor tracked twice, or names similar
  enough that one is likely a stray import.
- **Overlap detection** — four video streamers is not a duplicate, but it is
  a consolidation opportunity, so it is reported separately and more gently.
- **Unused subscriptions** — requires actual usage signal. Absence of data
  is reported as "unknown", never as "unused", so a user who has connected
  nothing does not get every subscription flagged.
- **Market price comparison** — against a low/typical/high band, and only
  flagged above the top of the band, because "you pay more than the cheapest
  tier" is noise when the bigger plan was deliberate.
- **Bundles and family plans** — Disney Bundle, Apple One, Microsoft 365
  Family, and per-service multi-seat tiers.
- **Price increases** — from recorded history, compared like-for-like so a
  cycle change is not mistaken for a rise, with cheaper alternatives.

Savings are counted **once per subscription**, so overlapping findings
cannot inflate the headline number into something the user will never
actually save.

### Forecasting
Holt's linear exponential smoothing with a **damped trend** and a capped
adaptation parameter, blended with known committed spend.

Why not ARIMA or Prophet? Both need a Python runtime and far more data to
beat exponential smoothing, and subscription spend is a short, monthly,
strongly-trending series — typically 6–36 points. Holt's method is the
standard choice at that length, runs in microseconds with no extra
dependency, and is transparent enough to explain to a user.

Three details that matter more than the model choice:

1. **The current month is excluded from fitting.** It is still accumulating
   charges, so including it reads as a collapse in spending and drags the
   fitted level down. (This was a real bug caught in testing: the forecast
   came out at $207 against $442 of committed spend.)
2. **The trend is damped** (φ = 0.85). Undamped, a single annual-renewal
   spike extrapolates into a doubling of spend within a quarter.
3. **Committed spend anchors the forecast.** Unlike a generic time series,
   we know exactly what the user is signed up for, so a large part of every
   future month is already determined.

Prediction intervals come from in-sample residuals and widen with the
square root of the horizon. Seasonality is only claimed after two full
cycles of history — one unusual December is not a pattern.

### Anomaly detection
Median and **Median Absolute Deviation**, not mean and standard deviation.
This is not a stylistic preference: a detector built on the mean is dragged
toward the very outlier it is meant to catch. In the demo data, a 4×
spending spike scores **z = 1.79** under a classic z-score — under the
3-sigma threshold, so it would be missed entirely — and **z = 201** under
MAD.

Also detects failed payments, charges after cancellation, charges above
plan, budget pressure, and cost outliers that are usually a typo (1599
instead of 15.99).

### Usage, value and churn scoring
Transparent, monotonic functions of observable facts rather than a fitted
classifier. A subscription tracker has no training labels — we never learn
whether the user actually cancelled on our advice — so a model here would
be fitting noise. Transparent scores can instead be explained back to the
user ("scored 3/100: 0 uses in 30 days at $44/month"), which is what makes
the advice actionable.

### Recommendations and benchmarking
Content-based (the service catalogue) plus item-to-item collaborative
filtering over vendor ids. Privacy constraints on the collaborative half:
only `vendor_id` is read, a cohort needs at least five distinct users before
it contributes, and benchmarks report percentile bands rather than
individual figures. On a fresh single-user install the collaborative half
returns nothing and the catalogue carries the feature — that is the
cold-start path, not a failure.

---

## Configuration

Every setting is documented in [`.env.example`](.env.example). The ones
that matter:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/subtrack` | Required in production |
| `REDIS_URL` | `redis://localhost:6379` | Optional; falls back to an in-process cache |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev-only values | **Production refuses to boot without real ones** |
| `ANTHROPIC_API_KEY` | _empty_ | Unset ⇒ heuristic mode |
| `CLAUDE_MODEL_FAST` / `CLAUDE_MODEL_SMART` | Haiku 4.5 / Sonnet 5 | Cheap model for parsing, stronger for narration |
| `AI_RATE_LIMIT_PER_HOUR` | `60` | Per-user ceiling on Claude calls |
| `SMTP_HOST` | _empty_ | Unset ⇒ mail is logged, including verification links |
| `ENABLE_SCHEDULER` | `true` | Renewal reminders and nightly insight generation |

Generate real secrets with `openssl rand -hex 48`.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | API + web with hot reload |
| `npm run dev:desktop` | Electron, pointed at the Vite dev server |
| `npm test` | All test suites |
| `npm run build` | Production web bundle |
| `npm run build:desktop` | Web bundle, then the macOS `.dmg` (**macOS only**) |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:seed` | Rebuild the demo account |
| `npm run db:reset` | Drop the schema, re-migrate, re-seed |

### Tests

```bash
npm test
```

102 tests: billing arithmetic and the service catalogue, the analytical
functions (optimiser, forecaster, anomaly detector, scoring, NLP, receipt
and e-mail parsing), the API client's error contract, and API integration
tests that run the real Express app against a real PostgreSQL database.

The integration tests need a `subtrack_test` database:

```bash
createdb subtrack_test
npm run test:migrate --workspace @subtrack/server
```

They cover the things that only exist in the database — row-level user
scoping, unique constraints, cascade deletes, refresh-token rotation —
because mocking those out would only test the mock.

The web UI is verified separately against a real headless Chromium
(rendering, dark mode, search, AI extraction, charts, the assistant, and
mobile layout at 390px with no horizontal overflow or console errors).

---

## API

All endpoints are under `/api`. Authenticated routes take
`Authorization: Bearer <accessToken>`.

<details>
<summary><strong>Authentication</strong></summary>

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/register` | Create an account (seeds default categories) |
| `POST` | `/auth/login` | Sign in |
| `POST` | `/auth/refresh` | Rotate the refresh token |
| `POST` | `/auth/logout` | Revoke the presented token |
| `POST` | `/auth/logout-all` | Revoke every session |
| `GET` | `/auth/sessions` | List active sessions |
| `POST` | `/auth/verify-email` | Confirm an address |
| `POST` | `/auth/forgot-password` | Request a reset link |
| `POST` | `/auth/reset-password` | Set a new password |
| `POST` | `/auth/change-password` | Change it while signed in |
</details>

<details>
<summary><strong>Subscriptions, categories and payments</strong></summary>

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/subscriptions` | List, with filter/sort/search |
| `POST` | `/subscriptions` | Create (auto-categorises) |
| `GET` `PATCH` `DELETE` | `/subscriptions/:id` | Read, update, delete |
| `POST` | `/subscriptions/:id/cancel` | Cancel, keeping history |
| `GET` | `/subscriptions/calendar?days=30` | Renewals expanded per occurrence |
| `POST` | `/subscriptions/:id/payments` | Record a payment |
| `POST` | `/subscriptions/:id/usage` | Record a use |
| `GET` `POST` | `/categories` | List / create |
| `PATCH` `DELETE` | `/categories/:id` | Update / delete |
| `GET` | `/categories/suggestions` | Suggested recategorisation |
</details>

<details>
<summary><strong>Analytics</strong></summary>

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/analytics/overview` | Dashboard headline figures |
| `GET` | `/analytics/categories` | Spend by category |
| `GET` | `/analytics/timeline?months=12` | Historical spend |
| `GET` | `/analytics/projections` | Deterministic forward projection |
| `GET` | `/analytics/forecast?horizon=6` | ML forecast with intervals |
| `GET` | `/analytics/forecast/categories` | Per-category forecasts |
| `GET` | `/analytics/trend` | Direction, volatility, seasonality |
| `GET` | `/analytics/optimize` | Every savings finding |
| `GET` | `/analytics/anomalies` | Unusual spend and charges |
| `GET` | `/analytics/usage` | Scored subscriptions |
| `GET` | `/analytics/value` | Best/worst value ranking |
| `GET` | `/analytics/recommendations` | Substitutes, gaps, peer picks |
| `GET` | `/analytics/benchmark` | Anonymous peer comparison |
| `GET` | `/analytics/export?type=subscriptions` | CSV download |
</details>

<details>
<summary><strong>AI</strong></summary>

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/ai/status` | Which mode and features are live |
| `POST` | `/ai/chat` | Send a message to the assistant |
| `GET` | `/ai/chat/sessions` | Conversation list |
| `GET` | `/ai/chat/:sessionId` | Transcript |
| `POST` | `/ai/chat/confirm` | Execute a proposed action |
| `POST` | `/ai/extract` | Text ⇒ subscription draft |
| `POST` | `/ai/categorise` | Suggest a category |
| `POST` | `/ai/receipt/text` | Parse pasted receipt text |
| `POST` | `/ai/receipt/image` | OCR a receipt image |
| `POST` | `/ai/email/scan` | Batch-scan messages for subscriptions |
| `GET` | `/ai/report` | Written spending report |
| `GET` `POST` | `/insights`, `/insights/generate` | Feed, regenerate |
| `GET` `POST` | `/notifications`, `/notifications/read` | Feed, mark read |
</details>

Every failure uses one shape, so clients have exactly one error path:

```json
{ "error": { "code": "bad_request", "message": "Validation failed",
             "details": { "cost": "Cost cannot be negative" },
             "requestId": "..." } }
```

---

## Security

- **Passwords** bcrypt at 12 rounds. Sign-in runs a bcrypt comparison even
  for addresses that do not exist, so response timing cannot be used to
  enumerate accounts — and the error is byte-identical either way.
- **Refresh tokens** are opaque, stored only as SHA-256 hashes, and rotate
  on every use. Replaying a *rotated* token is treated as theft and revokes
  every session for that account; a token retired by an explicit logout is
  simply rejected, so signing out one device does not sign out the others.
- **Verification and reset tokens** are also stored hashed, so a database
  dump cannot be replayed to seize accounts.
- **Every query is scoped by `user_id` in the SQL itself**, so a mismatched
  id returns 404 rather than leaking another account's row — and 404 rather
  than 403, which would confirm the id exists.
- **Strict validation** rejects unknown fields, which blocks a client from
  smuggling an AI-maintained column such as `usage_score` into an insert.
- **CSV export** prefixes formula-like values with a quote, so an imported
  subscription named `=cmd|...` cannot execute when the file is opened.
- **AI output** is length-capped and stripped of anything executable before
  rendering, and the model is told that subscription names, notes and
  receipts are data rather than instructions.
- **Rate limiting** in three tiers — general, strict on auth (failures
  only, so a user with many tabs is never locked out), and a per-user
  hourly ceiling on Claude calls.
- **Account deletion** cascades in one statement, leaving no orphaned
  personal data.

---

## Repository layout

```
packages/
├── shared/    Billing arithmetic, service catalogue, formatting.
│              Pure functions, used by the API and both clients.
├── server/    Express API, AI engine, analytics, background jobs.
├── web/       React + Vite client.
└── desktop/   Electron shell for macOS. See its own README.
```

### Data model

Money is `numeric(12,2)` — never a float, because 0.1 + 0.2 problems in a
billing app are not acceptable. Renewal dates are `date`, not
`timestamptz`: a renewal on the 14th is the 14th in every timezone, and
storing an instant introduces off-by-one-day bugs under negative UTC
offsets. Everything cascades from `users`, so account deletion is one
statement.

`users` · `subscriptions` · `categories` · `payment_history` ·
`price_history` · `usage_analytics` · `usage_events` · `ai_insights` ·
`chat_history` · `spending_predictions` · `notifications` ·
`refresh_tokens` · `auth_tokens`

---

## Deployment

The API is a stateless Node process; run as many as you like behind a load
balancer. Redis is what makes the AI rate limit and the analytics cache
shared across instances — without it each process keeps its own, which is
correct but less effective.

```bash
export NODE_ENV=production
export DATABASE_URL=postgres://…
export JWT_ACCESS_SECRET=$(openssl rand -hex 48)
export JWT_REFRESH_SECRET=$(openssl rand -hex 48)
export ANTHROPIC_API_KEY=sk-ant-…
export APP_URL=https://subtrack.example.com

npm ci --omit=dev
npm run db:migrate
npm start --workspace @subtrack/server
```

Production start-up validates its own configuration and refuses to boot
with development secrets, identical access and refresh secrets, secrets
under 32 characters, or a missing `DATABASE_URL`.

The background scheduler is safe to leave enabled on every instance:
notification delivery claims rows with `FOR UPDATE SKIP LOCKED`, so
several workers drain the queue in parallel without ever sending the same
reminder twice.

Serve `packages/web/dist` as static files from any CDN, with
`VITE_API_URL` pointed at the API at build time.

---

## Known limitations

- **Market prices are reference data, not a live feed.** The bands in the
  service catalogue were captured for demo purposes and every vendor
  reprices constantly. Treat them as "is this wildly off market", and
  replace `market` from your own pricing source for production use.
- **Peer benchmarking needs scale.** Below five users with overlapping
  subscriptions it is suppressed entirely to stay anonymous.
- **Bank feed integration is not implemented.** It needs a provider
  (Plaid/TrueLayer) and their compliance requirements; the payment history
  model is ready for it.
- **The desktop installer must be built on macOS.** electron-builder needs
  macOS tooling to produce, sign and notarise a `.dmg`.
- **Native speech recognition needs the Xcode command line tools** for the
  Swift helper. Without them the app falls back to the Web Speech API.

## Licence

MIT
