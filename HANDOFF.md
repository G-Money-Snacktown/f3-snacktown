# F3 Snacktown — Handoff & Open Items

**Site:** https://f3-snacktown.netlify.app
**Repo:** https://github.com/mlehane1/f3-snacktown
**Updated:** 2026-05-20

This is the running checklist for handing the Snacktown site over to the region
and finishing the analytics build. Use it to drive the handoff conversation.

---

## ✅ Done

- **Site is live and deployed** on the region's Netlify account.
- **Push-to-deploy is working** — the GitHub repo is connected to Netlify, so
  every push to `main` auto-builds and ships. (Fixed a build error today:
  `bcryptjs` is now installed via the repo-root `package.json`.)
- **Supabase backend** (PAX vault, leaderboard, region/AO stats) is live on the
  region's own Supabase account, fed nightly from the F3 Nation API.
- **Real logo** is now in the nav, favicon, and social-share image.
- **Env vars** set on Netlify: `F3_BEARER_TOKEN`, `F3_REGION_ORG_ID=25250`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

---

## 🔲 To finish the handoff

| # | Item | Who | Notes |
|---|------|-----|-------|
| 1 | **Transfer the GitHub repo** to the region's GitHub account | Marc → Han | GitHub → repo Settings → Danger Zone → *Transfer ownership*. Need Han's GitHub username. Do this **after** today; then re-link Netlify from Han's account so the connection is his. |
| 2 | **Join-form email notification** | Marc | Netlify → site → **Forms** → `join` → add a notification to **F3.Snacktown.PA@gmail.com**. Without it, "Join Us" submissions go nowhere. |
| 3 | **Admin password** (optional) | Han decides | Set `F3_ADMIN_PASSWORD` in Netlify if they want the `#admin` PAX-edit panel. |
| 4 | **Confirm logo looks right on a phone** | Han | Open the live site on a phone after the current deploy finishes. |

### ⏰ Time-sensitive
- The region's **7-day Netlify access token expires ~2026-05-25**. Once
  push-to-deploy is fully on Han's account (item 1), that token is no longer
  needed. If any manual deploy is required before then, the token must be
  refreshed.

---

## 📊 Next phase: advanced analytics (the "Waxhaw stats")

Goal: bring Snacktown the richer analytics F3 Waxhaw has — **streaks, weekly
leaderboards, AO trends & health, a Kotter "at-risk PAX" list, an activity
heatmap, and travel data.**

**Good news:** the source data (`f3data.analytics.*` in BigQuery) is
**region-wide**, so Snacktown's data (region 25250) is already in it. This is an
*adapt*, not a rebuild. The build is already scaffolded in the repo:
- `supabase/migration-analytics.sql` — the new analytics tables
- `bigquery-sync/AppsScript.gs` — the BigQuery→Supabase sync, ported for Snacktown
- `bigquery-sync/README.md` — setup steps

### What's needed to turn it on
1. **BigQuery access** — a Google account with **read access to the `f3data`
   project** (the same access Waxhaw uses), to run the sync script under.
   *→ confirm who that account will be.*
2. **The `BQ_PROJECT` value** from Waxhaw's live script (the GCP project the
   queries bill to). *→ Marc to provide.*
3. Run `migration-analytics.sql` in Supabase, then run the Apps Script once and
   install its daily/weekly triggers (see `bigquery-sync/README.md`).
4. **Remaining build (Marc):** Netlify functions to serve the new tables, plus
   front-end sections (leaderboards, streaks, AO health, heatmap) — mobile-first.

### ⚠️ One sensitivity note for the meeting
The **Kotter "at-risk PAX" list** names men who may be drifting away. It is
built **internal-only** (no public access) and should only ever be shown behind
an admin login. Worth a quick agreement on **who** should be able to see it.

---

## Architecture (one-paragraph recap)

Single `index.html` front end + Netlify serverless functions, hosted on Netlify,
auto-deployed from GitHub. Live schedule comes straight from the F3 Nation API;
PAX/leaderboard/stats come from a Supabase database refreshed nightly. The
optional analytics layer adds a Google Apps Script that pulls pre-aggregated data
from BigQuery into Supabase. Region content is edited in one `REGION CONFIG`
block in `index.html` (see `CLAUDE.md`).
