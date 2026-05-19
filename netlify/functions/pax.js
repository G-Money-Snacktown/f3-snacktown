/**
 * GET /api/pax — All PAX with stats
 * Query params: ?active=true (default) | ?active=false (all) | ?limit=400
 */
const { supabaseGet, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  try {
    const params = event.queryStringParameters || {};
    const limit = parseInt(params.limit) || 400;
    const activeOnly = params.active !== 'false';

    let query = '?select=*&order=workout_count.desc&limit=' + limit;
    if (activeOnly) {
      query += '&is_active_roster=eq.true';
    }

    const rows = await supabaseGet('v_pax_stats', query);
    return jsonResponse(rows, 200, 21600); // 6hr cache
  } catch (err) {
    console.error('PAX endpoint error:', err);
    return errorResponse(err.message);
  }
};
