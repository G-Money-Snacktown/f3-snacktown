/**
 * PUT /api/pax-overrides — Update PAX override fields (admin only)
 *
 * Path: /api/pax-overrides?id=123
 * Body: { "position": "...", "bio": "...", "photo_url": "...", "video_url": "..." }
 * Header: X-F3-Admin-Token: <token>
 *
 * Mirrors f3waxhaw f3-pax-endpoints.php admin pattern
 */
const {
  supabaseUpsert,
  verifyAdminToken,
  jsonResponse,
  errorResponse,
  corsResponse,
} = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'PUT') return errorResponse('Method not allowed', 405);

  // Admin auth check
  const token = event.headers['x-f3-admin-token'];
  const isAdmin = await verifyAdminToken(token);
  if (!isAdmin) {
    return errorResponse('Unauthorized. Provide a valid X-F3-Admin-Token header.', 401);
  }

  try {
    const params = event.queryStringParameters || {};
    const paxId = parseInt(params.id);
    if (!paxId) {
      return errorResponse('Missing required query param: id', 400);
    }

    const body = JSON.parse(event.body || '{}');

    // Only allow specific fields
    const allowed = ['position', 'bio', 'photo_url', 'video_url', 'display_order'];
    const payload = { pax_id: paxId, updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (body[key] !== undefined) {
        payload[key] = body[key];
      }
    }

    await supabaseUpsert('pax_overrides', payload);

    return jsonResponse({ ok: true, pax_id: paxId });
  } catch (err) {
    console.error('PAX overrides error:', err);
    return errorResponse(err.message);
  }
};
