/* ============================================================
   F3 Snacktown - Leaderboard API (NEW, v1 DRAFT)  bq-leaderboard.js
   Reads the BigQuery-fed leaderboard from Supabase.
   NEW name on purpose: does not replace any existing function.
   Needs these Netlify environment variables (already set on the site):
     SUPABASE_URL, SUPABASE_SERVICE_KEY
   No secrets in this file.

   GET /.netlify/functions/bq-leaderboard
     ?list=posts|qs|drps          (default posts)
     &group=Snacktown men|Visitors (default Snacktown men)
     &year=2025                    (omit = Lifetime)
     &ao=32675                     (omit = all AOs; one standard Snacktown AO)
     &drp=1                        (only the DRP group; do not combine with ao)
     &limit=100                    (1 to 200, default 100)
   ============================================================ */

const LISTS = ['posts', 'qs', 'drps'];
const GROUPS = ['Snacktown men', 'Visitors'];

function reply(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

// whole number inside a range, or null if the value is missing, or NaN if it is invalid
function wholeNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d+$/.test(String(value))) return NaN;
  const n = parseInt(value, 10);
  return n >= min && n <= max ? n : NaN;
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed' });
  }

  const q = event.queryStringParameters || {};
  const list = q.list || 'posts';
  const group = q.group || 'Snacktown men';
  const year = wholeNumber(q.year, 2000, 2100);
  const ao = wholeNumber(q.ao, 1, 2147483647);
  const limit = wholeNumber(q.limit, 1, 200);
  const drpOnly = q.drp === '1' || q.drp === 'true';

  if (!LISTS.includes(list)) return reply(400, { error: 'Unknown list' });
  if (!GROUPS.includes(group)) return reply(400, { error: 'Unknown group' });
  if (Number.isNaN(year) || Number.isNaN(ao) || Number.isNaN(limit)) {
    return reply(400, { error: 'Bad number in the request' });
  }
  if (drpOnly && ao !== null) return reply(400, { error: 'Pick an AO or DRP, not both' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('bq-leaderboard: SUPABASE_URL or SUPABASE_SERVICE_KEY is not set');
    return reply(500, { error: 'Leaderboard is updating, try again soon.' });
  }

  // Only send what was asked for; the database function has defaults for the rest.
  const args = { p_list: list, p_group: group, p_limit: limit === null ? 100 : limit };
  if (year !== null) args.p_year = year;
  if (ao !== null) args.p_ao_org_id = ao;
  if (drpOnly) args.p_drp_only = true;

  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/rest/v1/rpc/leaderboard', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    if (!res.ok) {
      console.error('bq-leaderboard: Supabase answered', res.status);
      return reply(502, { error: 'Leaderboard is updating, try again soon.' });
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('unexpected answer');
    return reply(
      200,
      {
        list, group, year, ao, drp: drpOnly,
        // user_id is left out on purpose: the page does not need it
        rows: rows.map((r) => ({ place: Number(r.place), name: r.f3_name, region: r.home_region_name, total: Number(r.total) }))
      },
      { 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    console.error('bq-leaderboard: failed', err && err.message);
    return reply(502, { error: 'Leaderboard is updating, try again soon.' });
  }
};
