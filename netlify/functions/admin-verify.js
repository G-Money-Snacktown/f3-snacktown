/**
 * POST /api/admin-verify — Authenticate admin and issue token
 *
 * Body: { "passcode": "..." }
 * Returns: { "ok": true, "token": "...", "expires_in": 3600 }
 *
 * Mirrors f3waxhaw f3-site-config.php lines 207-229
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const {
  supabaseGet,
  supabaseUpsert,
  supabaseDelete,
  jsonResponse,
  errorResponse,
  corsResponse,
} = require('./lib/supabase');

const PASSCODE_HASH = process.env.ADMIN_PASSCODE_HASH;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'POST') return errorResponse('Method not allowed', 405);

  if (!PASSCODE_HASH) {
    return errorResponse('No admin passcode configured.', 503);
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const passcode = (body.passcode || '').trim();

    if (!passcode) {
      return errorResponse('Passcode required.', 400);
    }

    // Rate limiting: check recent failed attempts from this IP
    const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    const ipHash = crypto.createHash('md5').update(ip).digest('hex').slice(0, 8);

    // Count recent tokens with this IP hash that are expired (failed attempts marker)
    // We use a simple approach: store failed attempts as expired tokens with ip_hash
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const recentFails = await supabaseGet('admin_tokens',
      `?ip_hash=eq.fail_${ipHash}&created_at=gte.${fiveMinAgo}&select=token`
    );

    if (recentFails.length >= 4) {
      return errorResponse('Too many failed attempts. Try again in 5 minutes.', 429);
    }

    // Verify passcode against bcrypt hash
    const valid = await bcrypt.compare(passcode, PASSCODE_HASH);

    if (!valid) {
      // Record failed attempt
      await supabaseUpsert('admin_tokens', [{
        token: `fail_${crypto.randomBytes(16).toString('hex')}`,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min
        ip_hash: `fail_${ipHash}`,
      }]);
      return errorResponse('Incorrect passcode.', 401);
    }

    // Generate token
    const token = crypto.randomBytes(24).toString('hex'); // 48 chars
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await supabaseUpsert('admin_tokens', [{
      token,
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      ip_hash: ipHash,
    }]);

    // Clean up old expired tokens
    await supabaseDelete('admin_tokens',
      `?expires_at=lt.${new Date().toISOString()}`
    ).catch(() => {});

    return jsonResponse({ ok: true, token, expires_in: 3600 });

  } catch (err) {
    console.error('Admin verify error:', err);
    return errorResponse(err.message);
  }
};
