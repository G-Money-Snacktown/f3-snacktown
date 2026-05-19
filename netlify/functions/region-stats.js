/**
 * GET /api/region-stats — Region-level aggregate statistics
 */
const { supabaseGet, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  try {
    const rows = await supabaseGet('v_region_stats', '?limit=1');
    const stats = rows[0] || {};
    return jsonResponse(stats, 200, 21600); // 6hr cache
  } catch (err) {
    console.error('Region stats endpoint error:', err);
    return errorResponse(err.message);
  }
};
