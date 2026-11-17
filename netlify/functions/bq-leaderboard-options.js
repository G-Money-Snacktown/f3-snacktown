/* ============================================================
   F3 Snacktown - Leaderboard dropdown options (NEW, v1 DRAFT)  bq-leaderboard-options.js
   Returns the years, the standard Snacktown AOs and the "updated" date.
   The page adds the extra "DRP" entry to the AO list itself.
   NEW name on purpose: does not replace any existing function.
   Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (already set). No secrets in this file.

   GET /.netlify/functions/bq-leaderboard-options
   ============================================================ */

function reply(status, body, extraHeaders) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}),
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed' });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('bq-leaderboard-options: SUPABASE_URL or SUPABASE_SERVICE_KEY is not set');
    return reply(500, { error: 'Leaderboard is updating, try again soon.' });
  }
  const base = url.replace(/\/+$/, '') + '/rest/v1/';
  const headers = { apikey: key, Authorization: 'Bearer ' + key };
  const get = async (path) => {
    const res = await fetch(base + path, { headers });
    if (!res.ok) throw new Error(path + ' answered ' + res.status);
    return res.json();
  };

  try {
    const [years, aos, lastRun] = await Promise.all([
      get('v_bq_feed_years?select=post_year&order=post_year.desc'),
      get('v_bq_feed_aos?select=ao_org_id,ao_name,posts&order=posts.desc'),
      get('v_bq_feed_last_run?select=finished_at,row_count')
    ]);
    if (!Array.isArray(years) || !Array.isArray(aos) || !Array.isArray(lastRun)) throw new Error('unexpected answer');
    if (years.length === 0) {
      // No completed load yet: tell the page plainly instead of showing empty dropdowns
      return reply(503, { error: 'Leaderboard is updating, try again soon.' });
    }
    return reply(
      200,
      {
        years: years.map((y) => Number(y.post_year)),
        aos: aos.map((a) => ({ id: Number(a.ao_org_id), name: a.ao_name })),
        updated: lastRun[0] ? lastRun[0].finished_at : null
      },
      { 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    console.error('bq-leaderboard-options: failed', err && err.message);
    return reply(502, { error: 'Leaderboard is updating, try again soon.' });
  }
};
