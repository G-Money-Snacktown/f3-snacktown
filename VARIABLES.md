# F3 Snacktown — Complete Variable & Credential Rundown

Every config value, secret, and account the site depends on — across all
layers. Use this at handoff so the region knows and controls all of them.

**Legend:** 🔒 = secret (never commit / never share publicly) · 📝 = editable
content (safe) · ✅ = already set · ⬜ = needed for the analytics phase

---

## A. Netlify environment variables
Site → **Site configuration → Environment variables**. These are read by the
serverless functions via `process.env.*`. They live ONLY in Netlify, never in
the repo.

| Variable | 🔒 | Used by | Current value / notes |
|---|---|---|---|
| `SUPABASE_URL` | | `lib/supabase.js` (all PAX functions) | `https://bzeesyzjiqqnrpxpppzh.supabase.co` ✅ |
| `SUPABASE_SERVICE_KEY` | 🔒 | `lib/supabase.js` | Supabase **service_role** key ✅ |
| `F3_BEARER_TOKEN` | 🔒 | `api.js`, `lib/supabase.js` | F3 Nation API bearer (region-specific) ✅ |
| `F3_REGION_ORG_ID` | | `api.js`, `lib/supabase.js` | `25250` (code defaults to 25250 if unset) ✅ |
| `F3_CLIENT_ID` | | `lib/supabase.js` | Optional; defaults to `f3-region-template`. Used as the F3 Nation `client` header. |
| `ADMIN_PASSCODE_HASH` | 🔒 | `admin-verify.js` | **bcrypt hash** of the admin passcode. Only needed if the `#admin` PAX-edit panel is used. ⬜ |

> ⚠️ **Heads-up on the admin variable.** The code reads **`ADMIN_PASSCODE_HASH`**
> and expects a **bcrypt hash** — NOT a plaintext password, and NOT
> `F3_ADMIN_PASSWORD` (an earlier setup note said that; it's wrong). To enable
> admin login, generate a bcrypt hash of the chosen passcode and store the hash
> in `ADMIN_PASSCODE_HASH`. If admin isn't needed, leave it unset.
>
> **Generate the hash:** `node scripts/gen-admin-hash.js "your-passcode"` →
> prints the `ADMIN_PASSCODE_HASH=...` value to paste into Netlify. The
> plaintext passcode is what you type on the site; only the hash is stored.

---

## B. Supabase project
Owned by the region (account **f3.snacktown.pa@gmail.com**).

| Item | 🔒 | Notes |
|---|---|---|
| Project URL | | `https://bzeesyzjiqqnrpxpppzh.supabase.co` (= `SUPABASE_URL`) ✅ |
| `service_role` key | 🔒 | Full DB access; used by Netlify functions + the Apps Script (= `SUPABASE_SERVICE_KEY`) ✅ |
| `anon` key | | Public read key. Not currently used (functions use service_role), but exists in the dashboard. |
| Database password | 🔒 | Set when the project was created; keep in a password manager. |
| Schema | | Apply `supabase/migration.sql` (core) + `supabase/migration-analytics.sql` (analytics) in the SQL Editor. ✅ core / ⬜ analytics |

---

## C. F3 Nation API
| Item | 🔒 | Notes |
|---|---|---|
| Bearer token | 🔒 | = `F3_BEARER_TOKEN`. Region-specific; came with the region's F3 Nation access. ✅ |
| Region Org ID | | `25250` — Snacktown. Must match `F3_REGION_ORG_ID` **and** `regionOrgId` in the CONFIG block. ✅ |
| API base | | `https://api.f3nation.com/v1` (hardcoded in `lib/supabase.js`). |
| `client` header | | = `F3_CLIENT_ID` (optional). |

---

## D. Netlify account & site
| Item | 🔒 | Notes |
|---|---|---|
| Account email | | **f3.snacktown.pa@gmail.com** (region owns the site) ✅ |
| Site ID | | `d0e3b370-3c5c-4ce0-add7-39168b4f9f38` ✅ |
| Site slug / URL | | `f3-snacktown` → https://f3-snacktown.netlify.app ✅ |
| Personal Access Token (PAT) | 🔒 | 7-day token used for CLI deploys. **Expires ~2026-05-25.** Not needed once push-to-deploy runs on the owner's account; refresh only if a manual CLI deploy is required before then. ⬜ |
| Forms → `join` notification | | Add an email notification to **F3.Snacktown.PA@gmail.com** so "Join Us" submissions are delivered. ⬜ |

---

## E. GitHub
| Item | 🔒 | Notes |
|---|---|---|
| Repo | | `github.com/mlehane1/f3-snacktown` — to be **transferred** to the region's GitHub account. ⬜ |
| Han's GitHub username | | Needed to perform the transfer. ⬜ |
| Netlify ↔ GitHub connection | | After transfer, re-link from the owner's Netlify so the OAuth connection is theirs. ⬜ |

---

## F. BigQuery analytics (next phase — Apps Script)
Constants at the top of `bigquery-sync/AppsScript.gs`.

| Variable | 🔒 | Notes |
|---|---|---|
| `SUPABASE_URL` | | Same Snacktown URL as above. ✅ (prefilled) |
| `SUPABASE_KEY` | 🔒 | Snacktown `service_role` key. ⬜ |
| `BQ_PROJECT` | | GCP project the BigQuery jobs run under — **same value Waxhaw uses**. ⬜ (Marc to provide) |
| `REGION_ID` | | `25250`. ✅ (prefilled) |
| `F3_NATION_TOKEN` | 🔒 | Snacktown F3 Nation bearer (only for scheduled-Q sync). ⬜ |
| Google account w/ `f3data` access | 🔒 | The script must run under a Google account that can read the `f3data` BigQuery project — same access as Waxhaw. **Decide who.** ⬜ |

---

## G. REGION CONFIG block (editable site content — NOT secrets)
In `index.html` (~line 1756), the single block the region edits. Changing the
site = editing here. 📝

| Key | Current value |
|---|---|
| `regionOrgId` | `25250` *(must match `F3_REGION_ORG_ID`)* |
| `regionName` | `Snacktown` |
| `city` | `Hanover, PA` |
| `founded` | `2019` |
| `aoCount` | `7` |
| `paxCount` | `50+` |
| `daysPerWeek` | `6` |
| `joinEmail` | `F3.Snacktown.PA@gmail.com` *(also the Forms target in §D)* |
| `aoFallback` | 7-AO static schedule (Jumpstart, Nomad, The Square, Gettysburg, The Corral, The Logpile, Kids Kingdom Park) |
| `facebookUrl` | `https://www.facebook.com/share/193UbPNFgk/` |
| `instagramUrl` | `https://www.instagram.com/f3snacktown` |
| `websiteUrl` | `https://f3snacktown.wordpress.com` |
| `legacySiteBase` | `https://f3snacktown.wordpress.com` |
| `hypeVideoUrl` | `https://www.facebook.com/share/193UbPNFgk/` |
| `heroDesc` / `aboutDesc` | Hero + about copy |
| `apiBase` | `/.netlify/functions/api` *(don't change)* |
| `paxApi`, `leaderboardApi`, `regionStatsApi`, `aoStatsApi`, `adminVerifyApi`, `paxOverridesApi`, `syncApi` | Function route paths *(don't change unless routing changes; blank `paxApi` to disable PAX features)* |

---

## Quick "who controls what" summary
- **Region (Han):** Netlify account, Supabase account, GitHub repo (after
  transfer), all secrets above, the CONFIG block content.
- **Shared / external:** F3 Nation API access (token + region 25250), the
  `f3data` BigQuery project (read access, same as Waxhaw).
- **Consistency rule:** `regionOrgId` (CONFIG) = `F3_REGION_ORG_ID` (Netlify) =
  `REGION_ID` (Apps Script) = **25250** everywhere.
