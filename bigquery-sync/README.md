# BigQuery → Supabase analytics sync

This folder holds the Google Apps Script that powers Snacktown's **advanced
analytics** (streaks, leaderboards, AO trends, the Kotter at-risk list, the
activity heatmap, and cross-region travel). It's a port of the proven F3
Waxhaw sync.

## How it works

```
f3data.analytics.*  ──(BigQuery query, filtered to region 25250)──►  Apps Script
        │                                                                  │
   (all F3 regions, fed                                          (computes streaks,
    by F3 Nation upstream)                                        leaderboards, etc.)
                                                                           │
                                                                           ▼
                                                        Snacktown Supabase tables
                                                        (pax_stats, ao_stats, …)
                                                                           │
                                                                           ▼
                                                        Netlify functions → site
```

The script **reads** from BigQuery (project `f3data`, dataset `analytics`) and
**writes** computed rows into Supabase. It does not populate BigQuery — F3
Nation does that upstream. Every query is filtered to `region_org_id = 25250`,
so Snacktown only ever sees its own data (except `syncTravelData`, which
intentionally looks at where Snacktown PAX post in *other* regions).

## Prerequisites

- A **Google account with read access to the `f3data` BigQuery project** — the
  same access F3 Waxhaw uses. This is the one external dependency.
- The Snacktown Supabase **service_role** key and project URL.
- The Snacktown F3 Nation **bearer token** (only used by `syncScheduledQs`).

## One-time setup

1. Go to <https://script.google.com> → **New project** (under the account that
   has `f3data` access). Paste in `AppsScript.gs`.
2. Editor → **Services** (＋) → add **BigQuery API**.
3. Fill in the 4 constants at the top of the script:
   - `SUPABASE_URL` — `https://bzeesyzjiqqnrpxpppzh.supabase.co` (already set)
   - `SUPABASE_KEY` — Snacktown service_role key
   - `BQ_PROJECT` — the GCP project that runs the queries (**same value as Waxhaw**)
   - `F3_NATION_TOKEN` — Snacktown bearer token
   - `REGION_ID` is already `25250`.
4. In the **Supabase SQL Editor**, run `supabase/migration-analytics.sql` (once)
   to create the tables the script writes into.
5. In the Apps Script editor, run **`syncAll`** once. Authorize the BigQuery +
   external-request scopes when prompted. Watch the execution log for HTTP 2xx.
6. Run **`backfillPaxActivity`** once to load a year of heatmap history.
7. Run **`setupTriggers`** once to install the schedule:
   - `syncDaily` — 5:00 AM ET daily
   - `syncWeekly` — 2:00 AM ET Sundays (heavier tables)

## What each function writes

| Function | Supabase table | Public? |
|---|---|---|
| `syncPaxStats` | `pax_stats` | yes |
| `syncRegionStats` | `bq_region_stats` | yes |
| `syncAoStats` | `ao_stats` | yes |
| `syncPaxAoBreakdown` | `pax_ao_breakdown` | yes |
| `syncStatsLeaders` | `stats_leaders` | yes |
| `syncPaxActivity` / `backfillPaxActivity` | `pax_activity` | yes |
| `syncScheduledQs` | `scheduled_qs` | yes |
| `syncTravelData` | `travel_locations` | yes |
| `syncKotterList` | `kotter_list` | **NO — internal only** |

## ⚠️ Kotter list is sensitive

`kotter_list` names PAX who may be drifting away (`new_drop` / `inactive` /
`fading` / `returning`). The migration deliberately gives it **no public read
policy** — it must only be served through an **admin-authenticated** Netlify
function, never the public anon key. The synced `kotter_list` and `stats_leaders`
tables are cleared-then-rewritten each run so recovered PAX and stale ranks
don't linger.

## Differences from the Waxhaw original

- Dropped the WordPress-specific functions (`syncUpcoming`, `invalidateWpCaches`)
  and the `WP_PASSCODE` constant — Snacktown serves data via Netlify functions,
  not WordPress.
- Added `clearTable()` and call it before rewriting `kotter_list`,
  `stats_leaders`, and `travel_locations`.
- `syncScheduledQs` sends `client: f3-snacktown`.

## Still to build (front-end side)

The tables and sync are ready, but two pieces of site work remain to surface
them (tracked in `HANDOFF.md`):
1. Netlify functions to serve the new tables (`stats-leaders`, `kotter` behind
   admin auth, etc.).
2. Front-end sections in `index.html` to display leaderboards, streaks, AO
   health, and the activity heatmap — mobile-first.
