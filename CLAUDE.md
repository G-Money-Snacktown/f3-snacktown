# CLAUDE.md — F3 Snacktown Region Site

Brief for any Claude session pointed at this repo. Read this first.

## What this is

The website for **F3 Snacktown** (Hanover, PA) — a free, peer-led men's
workout region. It's a **single-page app in one `index.html` file** plus a
handful of **Netlify serverless functions** that proxy the F3 Nation API and a
Supabase database. Hosted on Netlify at **https://f3-snacktown.netlify.app**.

There is no build step and no framework — `index.html` is plain HTML/CSS/JS
served as-is. The functions are Node.

## The golden rule: edit CONFIG for region content

99% of "change the site" requests are answered by editing **one block** near
the bottom of `index.html`:

```
// ╔══════════════════════════════════════════════╗
// ║  REGION CONFIG — EDIT THIS SECTION...         ║
```

Search the file for `REGION CONFIG` (around line 1754). It holds the region
name, city, AO (workout location) list, PAX count, social links, hero/about
copy, the Join email, and the API endpoint paths. Everything below the
`END OF CONFIG` marker is auto-generated from those values — **do not hardcode
region content elsewhere.** If a value shows up on the page, it almost
certainly traces back to a CONFIG key.

Key CONFIG fields:
- `regionOrgId` — F3 Nation region id. **Must be 25250 for Snacktown.** A wrong
  id silently pulls another region's data (PAX, AOs, events all look "off").
- `aoFallback` — the static schedule shown when the F3 Nation API returns no
  events. Keep it in sync with the real workout schedule.
- `paxApi` / `leaderboardApi` / etc. — leave as-is unless you're changing the
  function routing in `netlify.toml`.

## Repo map

```
index.html              ~2760 lines. The whole front end + REGION CONFIG block.
netlify.toml            Function dir, function bundler, /api/* → function redirects,
                        nightly sync cron (8am UTC).
netlify/functions/
  api.js                Proxies the F3 Nation schedule API (keeps bearer token server-side).
  pax.js                PAX list from Supabase.
  leaderboard.js        Leaderboard from Supabase.
  region-stats.js       Region-wide stats.
  ao-stats.js           Per-AO stats.
  admin-verify.js       Admin password check (bcrypt).
  pax-overrides.js      Manual PAX data overrides.
  sync.js               Nightly job: F3 Nation API → Supabase. ~30s if HTTP-invoked.
  lib/supabase.js       Shared Supabase + F3 Nation client. F3_BEARER lives here.
supabase/migration.sql  DB schema (9 tables + 4 views). Run once per region.
scripts/apply-supabase.sh   Helper to apply the migration + set env vars.
SUPABASE_SETUP.md       How to stand up the Supabase project for a region.
robots.txt, sitemap.xml SEO.
```

`node_modules/` and `.netlify/` are gitignored — don't commit them.

## Environment variables (NOT in the repo)

All secrets live in the **Netlify dashboard → Site settings → Environment
variables**, never in code. The repo only ever references them via
`process.env.*`. The four that matter:

| Var | Purpose |
|-----|---------|
| `F3_BEARER_TOKEN` | Auth for the F3 Nation API. Region-specific. |
| `F3_REGION_ORG_ID` | Must be `25250` (Snacktown). |
| `SUPABASE_URL` | Supabase project REST URL. |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key. **Secret — never print or commit.** |

If you ever see one of these values in a diff, stop — it shouldn't be there.

## How to deploy

As of this commit the Netlify site is **not** auto-deploying from this GitHub
repo. Two ways forward:

1. **Recommended:** In the Netlify dashboard, link this repo
   (Site settings → Build & deploy → Continuous deployment). After that, every
   push to `main` deploys automatically. No build command; publish directory is
   the repo root.
2. **Manual via CLI** (what was used to ship the first version):
   ```
   netlify deploy --prod --dir . --site <SITE_ID>
   ```
   This needs a `NETLIFY_AUTH_TOKEN` for the account that owns the site. The
   site id is visible in the Netlify dashboard URL.

After any deploy, **verify the live site** — curl the page or open it and
confirm the change actually rendered (Netlify's CDN can serve stale HTML
briefly).

## Supabase

The PAX / leaderboard / stats features read from a Supabase project owned by the
region. To set up a fresh region's database, follow `SUPABASE_SETUP.md` — it
walks through applying `supabase/migration.sql` and setting the two Supabase env
vars. If PAX features should be turned off entirely, blank out `paxApi` (and the
other `*Api` keys) in CONFIG.

The nightly `sync.js` cron refreshes Supabase from the F3 Nation API. Notes:
- The F3 Nation `events-and-locations` endpoint returns **positional arrays**
  `[id, name, logo, lat, lon, address, schedule]`, not objects — index by
  position, don't access `.id`.
- Events can reference location ids that the locations endpoint doesn't return;
  `sync.js` pre-inserts stub location rows to avoid orphans. Preserve that.
- If you ever invoke sync over HTTP and it dies at ~30s, that's the CDN dropping
  the connection, not a real failure. The scheduled cron gets a 15-min timeout.
  For an on-demand HTTP sync, rename `sync.js` → `sync-background.js` to get
  background-function semantics.

## Working style for this codebase

- **Mobile-first is mandatory.** Most PAX hit this on a phone before dawn. Check
  every layout change at a 360px-wide viewport before calling it done.
- **Edit `index.html` in place** — don't refactor the single-file structure into
  modules. That's a deliberate choice (the region owner can edit one file).
- **Diagnose before coding**, and **test the actual flow before telling the user
  it's fixed** — don't claim a fix you haven't verified renders correctly.
- **Watch template-literal pitfalls.** This file builds a lot of HTML via JS
  template strings. Be careful with nested backticks and with quotes/special
  chars inside `${...}` interpolations — they're a recurring source of breakage.

## What this site intentionally does NOT have

So you don't go looking for them: no backblasts, no PAX vault, no Bikes program,
no full admin CMS, no BigQuery integration, no Coffeeteria, no custom event
creation. The region owner can't self-edit without this repo or dashboard
access — the CONFIG block is the editing surface. If asked for those features,
they'd be net-new builds, not tweaks.
