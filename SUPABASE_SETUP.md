# F3 Snacktown — Supabase Setup

One-time wiring to light up PAX / Leaderboard / Region Stats.
Live schedule (today strip + Schedule + Events) does **not** require Supabase — it already works from the F3 Nation API.

## 1. Create the Supabase project (browser, ~3 min)

1. https://app.supabase.com → **New project**
2. Name: `f3-snacktown`
3. Database password: generate + save in a password manager
4. Region: **East US (N. Virginia)** — closest to Hanover, PA
5. Plan: Free
6. Wait for provisioning (~2 min)

## 2. Grab the URL + service_role key

Project settings → **API**:
- Copy **Project URL** → looks like `https://abcdefghijk.supabase.co`
- Copy **service_role secret** (NOT the anon key) → starts with `eyJhbGciOi…`

Paste both back to Claude. They become `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in Netlify.

## 3. Run the schema migration

Supabase dashboard → **SQL Editor** → **New query** → paste the entire contents of `supabase/migration.sql` → **Run**.

Safe to re-run (uses `IF NOT EXISTS` / `CREATE OR REPLACE`).

## 4. Claude wires Netlify env vars

```bash
netlify env:set SUPABASE_URL "<URL>"
netlify env:set SUPABASE_SERVICE_KEY "<key>"
```

## 5. Trigger initial sync (one-time)

After the next Netlify deploy picks up the new env vars:

```bash
curl -X POST "https://f3-snacktown.netlify.app/.netlify/functions/sync"
```

First call auto-detects "no prior sync" → runs full backfill (2 years history). Sync runs up to 14 minutes; chunks/resumes automatically if it hits the limit. Nightly scheduled sync (8am UTC / 3am ET) handles incremental updates from there.

## 6. Verify

- https://f3-snacktown.netlify.app/api/region-stats → should return non-zero `active_pax_count`
- https://f3-snacktown.netlify.app/#pax → PAX vault populates, leaderboard ranks, stats grid shows numbers

## Optional: admin login

For the PAX edit panel:

```bash
netlify env:set F3_ADMIN_PASSWORD "<choose a password>"
```

Then on the deployed site, append `#admin` to the URL to reveal the Admin button.
