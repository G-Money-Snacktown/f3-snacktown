/* ============================================================
   F3 Snacktown - Regional Data Box 1 API (NEW, v1)  bq-region-box1.js
   Returns the one-row "7 box" region stats from Supabase.
   NEW name on purpose: does not replace any existing function.
   Needs these Netlify environment variables (already set on the site):
     SUPABASE_URL, SUPABASE_SERVICE_KEY
   No secrets in this file.

   GET /.netlify/functions/bq-region-box1
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
    console.error('bq-region-box1: SUPABASE_URL or SUPABASE_SERVICE_KEY is not set');
    return reply(500, { error: 'Region stats are updating, try again soon.' });
  }

  const path = 'bq_region_box1' +
    '?select=total_workouts,total_posts,active_pax,unique_qs,total_fngs,ao_count_90d,avg_attendance,loaded_at' +
    '&id=eq.1';

  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/rest/v1/' + path, {
      headers: { apikey: key, Authorization: 'Bearer ' + key }
    });
    if (!res.ok) {
      console.error('bq-region-box1: Supabase answered', res.status);
      return reply(502, { error: 'Region stats are updating, try again soon.' });
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error('unexpected answer');
    if (rows.length === 0) {
      return reply(503, { error: 'Region stats are updating, try again soon.' });
    }
    const r = rows[0];
    return reply(
      200,
      {
        total_workouts: Number(r.total_workouts),
        total_posts: Number(r.total_posts),
        active_pax: Number(r.active_pax),
        unique_qs: Number(r.unique_qs),
        total_fngs: Number(r.total_fngs),
        ao_count_90d: Number(r.ao_count_90d),
        avg_attendance: Number(r.avg_attendance),
        updated: r.loaded_at
      },
      { 'Cache-Control': 'public, max-age=300' }
    );
  } catch (err) {
    console.error('bq-region-box1: failed', err && err.message);
    return reply(502, { error: 'Region stats are updating, try again soon.' });
  }
};
