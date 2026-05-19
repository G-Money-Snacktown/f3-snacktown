/**
 * Shared Supabase + F3 Nation API helpers for Netlify Functions.
 *
 * Mirrors the patterns from f3waxhaw's f3-nation-sync.php (lines 718-789)
 * and f3-pax-endpoints.php, adapted for Node.js.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const F3_API_BASE = 'https://api.f3nation.com/v1';
const F3_BEARER = process.env.F3_BEARER_TOKEN;
const F3_CLIENT = process.env.F3_CLIENT_ID || 'f3-region-template';
const F3_REGION_ORG_ID = process.env.F3_REGION_ORG_ID || '25250';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-F3-Admin-Token',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

// ── Supabase helpers ────────────────────────────────────────

/**
 * GET from Supabase PostgREST. Returns parsed JSON array/object.
 * @param {string} table - Table or view name
 * @param {string} query - PostgREST query string (e.g., "?select=*&id=eq.1")
 */
async function supabaseGet(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const resp = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase GET ${table} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Upsert (insert or merge on conflict) into Supabase.
 * Uses PostgREST's resolution=merge-duplicates header.
 * @param {string} table
 * @param {Object|Array} payload - Single object or array of objects
 */
async function supabaseUpsert(table, payload) {
  const body = Array.isArray(payload) ? payload : [payload];
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase UPSERT ${table} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

/**
 * PATCH (partial update) rows in Supabase matching a filter.
 * @param {string} table
 * @param {string} filter - PostgREST filter (e.g., "?id=eq.123")
 * @param {Object} payload
 */
async function supabasePatch(table, filter, payload) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase PATCH ${table} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

/**
 * DELETE rows from Supabase matching a filter.
 * @param {string} table
 * @param {string} filter - PostgREST filter (e.g., "?expires_at=lt.2026-04-08")
 */
async function supabaseDelete(table, filter) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}${filter}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase DELETE ${table} ${resp.status}: ${text.slice(0, 200)}`);
  }
  return true;
}


// ── F3 Nation API helper ────────────────────────────────────

/**
 * Make an authenticated GET request to the F3 Nation API.
 * @param {string} path - API path (e.g., "/event-instance")
 * @param {Object} params - Query parameters
 * @returns {Object} Parsed JSON response
 */
async function f3ApiGet(path, params = {}) {
  const url = new URL(`${F3_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) {
      v.forEach(item => url.searchParams.append(k, item));
    } else if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }
  const resp = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${F3_BEARER}`,
      'Client': F3_CLIENT,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`F3 API ${resp.status} ${path}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}


// ── Admin auth helpers ──────────────────────────────────────

/**
 * Verify an admin token from the X-F3-Admin-Token header.
 * Checks against admin_tokens table, auto-cleans expired tokens.
 * @param {string} token
 * @returns {boolean}
 */
async function verifyAdminToken(token) {
  if (!token) return false;
  try {
    // Clean expired tokens opportunistically
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/cleanup_expired_tokens`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    const rows = await supabaseGet('admin_tokens',
      `?token=eq.${encodeURIComponent(token)}&expires_at=gt.${new Date().toISOString()}&select=token`
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}


// ── Response helpers ────────────────────────────────────────

function jsonResponse(data, statusCode = 200, cacheSeconds = 0) {
  const headers = { ...CORS_HEADERS };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}`;
  }
  return {
    statusCode,
    headers,
    body: JSON.stringify(data),
  };
}

function errorResponse(message, statusCode = 500) {
  return jsonResponse({ error: message }, statusCode);
}

function corsResponse() {
  return { statusCode: 204, headers: CORS_HEADERS, body: '' };
}


// ── Rate limiter for F3 Nation API ──────────────────────────

class RateLimiter {
  constructor(maxRequests = 180, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  async waitIfNeeded() {
    const now = Date.now();
    // Prune old timestamps
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      const oldest = this.timestamps[0];
      const waitMs = this.windowMs - (now - oldest) + 100; // +100ms buffer
      if (waitMs > 0) {
        await new Promise(r => setTimeout(r, waitMs));
      }
      // Re-prune after waiting
      const afterWait = Date.now();
      this.timestamps = this.timestamps.filter(t => afterWait - t < this.windowMs);
    }

    this.timestamps.push(Date.now());
  }
}


module.exports = {
  SUPABASE_URL,
  SUPABASE_KEY,
  F3_API_BASE,
  F3_BEARER,
  F3_CLIENT,
  F3_REGION_ORG_ID,
  CORS_HEADERS,
  supabaseGet,
  supabaseUpsert,
  supabasePatch,
  supabaseDelete,
  f3ApiGet,
  verifyAdminToken,
  jsonResponse,
  errorResponse,
  corsResponse,
  RateLimiter,
};
