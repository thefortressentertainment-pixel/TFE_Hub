# Fortress Hub — Free Hosting Setup (Render + Neon + Upstash)

No credit card required. Each step is a separate free signup.

---

## 1. Neon (Postgres database)

1. Go to **https://neon.tech** → **Sign up** (GitHub or email)
2. After login, a project is auto-created. Click **Create** if prompted.
3. In the dashboard, find **Connection string** (looks like `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require`)
4. Copy it — you'll need it in step 4.

## 2. Upstash (Redis queue)

1. Go to **https://upstash.com** → **Sign up**
2. Create a new **Redis** database (free tier, 256MB)
3. In the database, go to **Connect** → copy the connection string. It looks like:
   `rediss://default:password@xxx.upstash.io:6379`
4. Save it for step 4.

## 3. Render (app hosting)

1. Go to **https://render.com** → **Sign up** (GitHub recommended)
2. You'll create the services in step 5, but sign in first.

## 4. Before deploying — add secrets to GitHub

Put these as **repository secrets** so Render reads them at deploy time.
Actually, simplest: define env vars directly in Render (step 5).

## 5. Deploy on Render

Use the **Blueprint** method so both services are created at once:

1. In Render dashboard: **New → Blueprint**
2. Connect your GitHub account and select the `fortress-hub` repo (or `TFE_Hub`)
3. Render reads `render.yaml` and asks for the values of the `sync: false` env vars.
4. Fill them in:
   - `DATABASE_URL` = the Neon connection string from step 1
   - `REDIS_URL` = the Upstash connection string from step 2
   - `OPENAI_API_KEY` = (optional) your OpenAI key
5. **Apply** the blueprint.

Render creates two services:
- **tfe-hub** (web) → `https://tfe-hub.onrender.com`
- **tfe-hub-worker** (background worker)

6. First deploy takes a few minutes (installs deps, builds frontend).

## 6. Run database migrations

After the web service is up, run migrations so the tables exist.

In the Render dashboard for **tfe-hub**:
1. **Shell** tab
2. Run:
   ```
   node backend/migrations/run.js
   ```

## 7. Point your apps at it

- Open the app → **Settings** → set **Backend URL** to `https://tfe-hub.onrender.com` → Save
- The URL is permanent — native iOS/Android apps only need this set once.

---

## Free-tier caveats

- **Sleeping**: Render's free web service sleeps after ~15 min of inactivity. First request after sleep takes ~30s to wake. A free uptime pinger (e.g., UptimeRobot, ping every 5 min) keeps it warm.
- **Worker**: Render free workers also sleep; receipts queue in Redis until a worker wakes.
- **Upstash/Bull**: If the worker fails to connect to Upstash Redis, the backend falls back to processing uploads inline (slower, but nothing is lost).

## Production (later, when you're ready)

The `fly.toml` + `Dockerfile` are still in the repo — one command deploys to Fly when you want paid always-on hosting.
