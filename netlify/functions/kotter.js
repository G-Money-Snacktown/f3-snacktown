/**
 * GET /api/kotter — "PAX at risk" list (Kotter list). ADMIN ONLY.
 *
 * Header: X-F3-Admin-Token: <token>
 *
 * This names men who may be drifting away (new_drop / inactive / fading /
 * returning). It is deliberately NOT public — kotter_list has no anon-read
 * policy, and this endpoint requires a valid admin token. Never cache it.
 *
 * Data is written by the BigQuery sync (bigquery-sync/AppsScript.gs →
 * kotter_list table). Empty until that sync runs.
 */
const { supabaseGet, verifyAdminToken, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  const token = event.headers['x-f3-admin-token'];
  const isAdmin = await verifyAdminToken(token);
  if (!isAdmin) {
    return errorResponse('Unauthorized. Provide a valid X-F3-Admin-Token header.', 401);
  }

  try {
    const rows = await supabaseGet('kotter_list',
      '?select=pax_id,handle,avatar_url,total_posts,last_post,last_ao,days_since,posts_recent_4wk,posts_prior_4wk,kotter_status' +
      '&order=days_since.desc&limit=500'
    );
    return jsonResponse({ pax: rows }, 200, 0); // never cache — sensitive
  } catch (err) {
    console.error('kotter endpoint error:', err);
    return errorResponse(err.message);
  }
};
