/**
 * GET /api/ao-stats — Per-AO statistics
 * Query params: ?id=123 (single AO) or none (all AOs)
 */
const { supabaseGet, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  try {
    const params = event.queryStringParameters || {};

    let query = '?select=*&order=avg_pax_recent.desc.nullslast';
    if (params.id) {
      query += `&ao_org_id=eq.${parseInt(params.id)}`;
    }

    const rows = await supabaseGet('v_ao_stats', query);

    if (params.id) {
      return jsonResponse(rows[0] || null, rows[0] ? 200 : 404, 21600);
    }
    return jsonResponse(rows, 200, 21600); // 6hr cache
  } catch (err) {
    console.error('AO stats endpoint error:', err);
    return errorResponse(err.message);
  }
};
