/**
 * GET /api/stats-leaders — record-board leaders across categories
 *
 * Returns { categories: { <category>: [ {rank, handle, avatar_url, value, detail}, ... ] } }
 * Categories: longest_streak, most_posts_one_week, most_qs_one_week,
 *             most_unique_ao_qs, most_posts_single_ao
 *
 * Data is written by the BigQuery sync (bigquery-sync/AppsScript.gs →
 * stats_leaders table). Empty until that sync runs.
 */
const { supabaseGet, jsonResponse, errorResponse, corsResponse } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();
  if (event.httpMethod !== 'GET') return errorResponse('Method not allowed', 405);

  try {
    const rows = await supabaseGet('stats_leaders',
      '?select=category,rank,handle,avatar_url,value,detail&order=category.asc,rank.asc&limit=500'
    );

    const categories = {};
    for (const r of rows) {
      (categories[r.category] = categories[r.category] || []).push(r);
    }

    return jsonResponse({ categories }, 200, 7200); // 2hr cache
  } catch (err) {
    console.error('stats-leaders endpoint error:', err);
    return errorResponse(err.message);
  }
};
