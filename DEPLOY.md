# Deploying FlowForce WFM (public URL)

Get a permanent `https://…` link: **backend on Render**, **frontend on Vercel**.
Both have free tiers and deploy straight from this GitHub repo.

> Free-tier notes: the Render backend sleeps after ~15 min idle, so the *first*
> request after a nap takes ~30–60s to wake (a "cold start"). Render's free
> Postgres expires after 90 days. Fine for a demo.

---

## 1) Backend + database on Render

1. Go to **https://dashboard.render.com/blueprints** → **New Blueprint Instance**.
2. Connect this GitHub repo (`Rahul9136-ai/Khyati`). Render reads **`render.yaml`**
   and provisions a **Postgres database** + the **`khyati-backend`** web service.
3. Click **Apply** and wait for the build + deploy to finish (a few minutes).
   On first boot it runs the DB migrations and seeds the demo data automatically.
4. Copy the backend URL, e.g. `https://khyati-backend.onrender.com`.
5. Verify it's up: open `https://khyati-backend.onrender.com/api/v1/health`
   → should return `{"status":"ok",...}` (and `/docs` for the API docs).

## 2) Frontend on Vercel

1. Go to **https://vercel.com/new** and **import** the same GitHub repo.
2. **Root Directory → `frontend`** (important — the app lives in that subfolder).
   Framework preset auto-detects **Vite**; build settings come from `vercel.json`.
3. Add an **Environment Variable**:
   - **Name:** `VITE_API_BASE_URL`
   - **Value:** `https://khyati-backend.onrender.com/api/v1`  ← your Render URL + `/api/v1`
4. Click **Deploy**. Copy the resulting URL, e.g. `https://khyati.vercel.app`.

## 3) Point the backend at the frontend (CORS)

The API must allow requests from your Vercel domain:

1. In Render → **khyati-backend** → **Environment**, set (no trailing slash):
   - `BACKEND_CORS_ORIGINS` = `https://khyati.vercel.app`
   - `APP_WEB_URL` = `https://khyati.vercel.app`
2. Save — the backend redeploys automatically.

## 4) Open it

Visit your Vercel URL and sign in:

- **admin@flowforce.dev** / **Admin@12345** (Super Admin)

You'll see **Capacity Planning** (the AGS Health CP module) and **Approval Bridge**.

---

### Redeploys
Both hosts auto-deploy on every push to `main`, so future changes go live on
their own. The seeder is idempotent (skips if the demo org already exists), so
redeploys won't duplicate data.

### Alternative: full stack on one host
`docker-compose.yml` runs the whole stack (Postgres + Redis + backend + nginx
SPA) on any Docker host — `docker compose up -d --build` then
`docker compose exec backend python -m app.db.seed`.
