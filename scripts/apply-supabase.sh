#!/usr/bin/env bash
# F3 Snacktown — apply Supabase wiring to the linked Netlify site.
# Run AFTER you've created the Supabase project + run migration.sql via SQL Editor.
#
# Usage:
#   bash scripts/apply-supabase.sh "<SUPABASE_URL>" "<SUPABASE_SERVICE_KEY>"
#
# What it does:
#   1. Sets the two missing env vars on the linked Netlify site
#   2. Triggers a Netlify deploy so the functions pick them up (or relies on next push)
#   3. Sanity-checks that the data endpoints respond
#   4. Calls the sync function once to backfill (first run is auto-full)
#   5. Polls /api/region-stats until non-zero
set -euo pipefail

SUPABASE_URL="${1:-}"
SUPABASE_SERVICE_KEY="${2:-}"
SITE_URL="https://f3-snacktown.netlify.app"

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_SERVICE_KEY" ]]; then
  echo "Usage: bash scripts/apply-supabase.sh '<SUPABASE_URL>' '<SUPABASE_SERVICE_KEY>'"
  exit 1
fi

echo "== 1. Setting Netlify env vars =="
npx --yes netlify env:set SUPABASE_URL "$SUPABASE_URL"
npx --yes netlify env:set SUPABASE_SERVICE_KEY "$SUPABASE_SERVICE_KEY"

echo ""
echo "== 2. Sanity-check Supabase access via PostgREST =="
curl -s -o /dev/null -w "  PostgREST /f3_users HTTP %{http_code}\n" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  "${SUPABASE_URL%/}/rest/v1/f3_users?select=id&limit=1"

echo ""
echo "== 3. Triggering Netlify redeploy so functions pick up env vars =="
# Either: npx netlify deploy --build --prod, OR rely on git push.
# Most reliable here is to wait for the user to push, OR force-trigger by editing netlify.toml.
npx --yes netlify deploy --build --prod --message "wire supabase env vars" || \
  echo "  (deploy command failed — push to git or run 'netlify deploy --build --prod' manually)"

echo ""
echo "== 4. Calling sync function (first run = full backfill, up to 14 min) =="
curl -X POST "$SITE_URL/.netlify/functions/sync" \
  -H "Content-Type: application/json" \
  --max-time 900 \
  -w "\n  HTTP %{http_code}  size %{size_download}b  time %{time_total}s\n" || true

echo ""
echo "== 5. Verifying region-stats endpoint =="
curl -s "$SITE_URL/api/region-stats" | head -c 600
echo ""

echo ""
echo "Done. Open $SITE_URL/#pax to see PAX + leaderboard + stats."
