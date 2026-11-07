/**
 * GET /api/leaderboard — PAXs leaderboard with monthly activity
 *
 * Returns { pax: [...], month_label: "April 2026" }
 * Mirrors f3waxhaw f3-pax-endpoints.php lines 125-159
 */
const { supabaseGet, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  try {
    // Fetch all active PAX stats
    const pax = await supabaseGet('v_pax_stats',
      '?select=pax_id,handle,avatar_url,workout_count,workout_count_ytd,q_count,q_count_ytd,coq_count,home_ao_id,is_active_roster,position,override_photo_url' +
      '&is_active_roster=eq.true&order=workout_count.desc&limit=200'
    );

    // Fetch current month's activity
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const activity = await supabaseGet('v_pax_activity',
      `?select=pax_id,post_count&post_date=gte.${monthStart}&limit=5000`
    );

    // Aggregate monthly counts
    const monthly = {};
    for (const row of activity) {
      const pid = row.pax_id;
      monthly[pid] = (monthly[pid] || 0) + (row.post_count || 1);
    }

    // Merge monthly counts into PAX
    for (const p of pax) {
      p.workout_count_month = monthly[p.pax_id] || 0;
    }

    const monthLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    return jsonResponse({ pax, month_label: monthLabel }, 200, 7200); // 2hr cache
  } catch (err) {
    console.error('Leaderboard endpoint error:', err);
    return errorResponse(err.message);
  }
};
