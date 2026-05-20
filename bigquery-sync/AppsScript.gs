/**
 * F3 SNACKTOWN — BigQuery → Supabase analytics sync
 * ===================================================
 * Ported from the F3 Waxhaw Apps Script. Reads pre-aggregated F3 Nation
 * data out of the shared `f3data.analytics.*` BigQuery dataset (filtered
 * to Snacktown, region 25250) and upserts computed analytics into the
 * Snacktown Supabase project. The site's Netlify functions then serve
 * those tables.
 *
 * SETUP (see bigquery-sync/README.md for the full walkthrough):
 *   1. Apps Script editor → Services (+) → add "BigQuery API".
 *   2. Fill in the 4 constants below.
 *   3. Run `syncAll` once manually and authorize the scopes.
 *   4. Run `backfillPaxActivity` once for the activity heatmap history.
 *   5. Run `setupTriggers` once to install the daily + weekly schedules.
 *
 * The Google account this script runs under MUST have read access to the
 * `f3data` BigQuery project — the same access Waxhaw uses.
 */

// ── CONFIG — fill these in ─────────────────────────────────────
const SUPABASE_URL    = 'https://bzeesyzjiqqnrpxpppzh.supabase.co'; // Snacktown Supabase project URL
const SUPABASE_KEY    = 'YOUR_SUPABASE_SERVICE_KEY';                // Snacktown service_role key (secret)
const BQ_PROJECT      = 'YOUR_BQ_PROJECT';                          // GCP project that runs the BQ jobs (same as Waxhaw)
const REGION_ID       = 25250;                                     // F3 Nation region id — Snacktown
const F3_NATION_TOKEN = 'YOUR_F3_BEARER_TOKEN';                     // Snacktown F3 Nation bearer (for scheduled Qs)
// ───────────────────────────────────────────────────────────────


function cleanHandle(handle) {
  if (!handle) return 'Unknown';
  return handle
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/\s*-\s*\S+$/, '')
    .trim();
}

function bqQuery(sql) {
  const job = BigQuery.Jobs.query(
    { query: sql, useLegacySql: false, timeoutMs: 60000 },
    BQ_PROJECT
  );
  if (!job.jobComplete) throw new Error('Query timed out');
  const fields = job.schema.fields.map(f => f.name);
  return (job.rows || []).map(row =>
    Object.fromEntries(fields.map((f, j) => [f, row.f[j]?.v ?? null]))
  );
}

// return=minimal stops Supabase from echoing rows back (cuts egress in half).
// Batch 1000 is PostgREST's sweet spot.
function supabaseUpsert(table, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 1000) {
    const resp = UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=minimal',
      },
      payload:            JSON.stringify(rows.slice(i, i + 1000)),
      muteHttpExceptions: true,
    });
    Utilities.sleep(300);
    const code = resp.getResponseCode();
    const body = (code < 200 || code >= 300) ? ' — ' + resp.getContentText().slice(0, 200) : '';
    Logger.log(`${table} batch ${Math.floor(i/1000)+1}: HTTP ${code}${body}`);
  }
}

// Hard-clears a table before a full rewrite. Used for tables where rows can
// stop qualifying between runs (Kotter list, leaderboard ranks) so recovered
// PAX / stale ranks don't linger. PostgREST requires a filter on DELETE.
function clearTable(table, filterCol) {
  UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/${table}?${filterCol}=not.is.null`, {
    method:  'DELETE',
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer':        'return=minimal',
    },
    muteHttpExceptions: true,
  });
}

function syncPaxStats() {
  const year = new Date().getFullYear();
  Logger.log('Syncing PAX stats...');

  const rows = bqQuery(`
    SELECT
      a.user_id,
      a.f3_name                                                                            AS handle,
      a.avatar_url,
      COUNT(*)                                                                             AS workout_count,
      COUNT(CASE WHEN EXTRACT(YEAR FROM a.start_date) = ${year} THEN 1 END)               AS workout_count_ytd,
      SUM(a.q_ind)                                                                         AS q_count,
      SUM(CASE WHEN EXTRACT(YEAR FROM a.start_date) = ${year} THEN a.q_ind   ELSE 0 END)  AS q_count_ytd,
      SUM(a.coq_ind)                                                                       AS coq_count,
      MAX(a.start_date)                                                                    AS last_attended,
      APPROX_TOP_COUNT(e.ao_name, 1)[OFFSET(0)].value                                     AS home_ao,
      RANK() OVER (ORDER BY
        SUM(CASE WHEN EXTRACT(YEAR FROM a.start_date) = ${year} THEN a.q_ind ELSE 0 END) DESC,
        SUM(a.q_ind) DESC
      )                                                                                    AS rank
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID} AND a.user_statusa = 'active'
    GROUP BY a.user_id, a.f3_name, a.avatar_url
    ORDER BY workout_count DESC
  `);

  const paxRows = rows.map(r => ({
    pax_id:            parseInt(r.user_id),
    handle:            cleanHandle(r.handle),
    avatar_url:        r.avatar_url        || null,
    workout_count:     parseInt(r.workout_count)     || 0,
    workout_count_ytd: parseInt(r.workout_count_ytd) || 0,
    q_count:           parseInt(r.q_count)            || 0,
    q_count_ytd:       parseInt(r.q_count_ytd)        || 0,
    coq_count:         parseInt(r.coq_count)          || 0,
    last_attended:     r.last_attended     || null,
    home_ao:           r.home_ao           || null,
    rank:              parseInt(r.rank)     || null,
    is_active_roster:  r.last_attended
                         ? (new Date() - new Date(r.last_attended)) < (548 * 86400000)
                         : false,
    synced_at:         new Date().toISOString(),
  }));

  supabaseUpsert('pax_stats', paxRows);
  Logger.log(`PAX stats: ${paxRows.length} rows`);
}

function syncRegionStats() {
  Logger.log('Syncing region stats...');

  // NULL pax_count = backblast missing. Separate "tracked" (has backblast) from "scheduled" (total) so averages stay honest.
  const statsSql = `
    SELECT
      COUNT(DISTINCT CASE WHEN e.pax_count IS NOT NULL THEN e.id END)  AS total_workouts,
      COUNT(DISTINCT e.id)                                              AS scheduled_workouts,
      COUNT(*)                                                          AS total_posts,
      SUM(e.pax_count)                                                  AS total_pax,
      SUM(e.fng_count)                                                  AS total_fngs,
      COUNT(DISTINCT e.ao_org_id)                                       AS ao_count,
      COUNT(DISTINCT a.user_id)                                         AS active_pax,
      ROUND(AVG(e.pax_count), 1)                                        AS avg_pax,
      COUNT(DISTINCT CASE WHEN a.q_ind = 1 THEN a.user_id END)         AS unique_qs
    FROM \`f3data.analytics.event_info\`      e
    JOIN \`f3data.analytics.attendance_info\` a ON a.event_instance_id = e.id
    WHERE e.region_org_id = ${REGION_ID}
  `;

  const daysSql = `
    SELECT
      FORMAT_DATE('%A', e.start_date)  AS day_name,
      COUNT(*)                          AS total_posts,
      COUNT(DISTINCT CASE WHEN e.pax_count IS NOT NULL THEN e.id END)  AS total_workouts,
      ROUND(AVG(e.pax_count), 1)        AS avg_pax
    FROM \`f3data.analytics.event_info\` e
    WHERE e.region_org_id = ${REGION_ID}
      AND e.start_date IS NOT NULL
    GROUP BY day_name
    ORDER BY total_posts DESC
  `;

  const topAosSql = `
    SELECT
      e.ao_name,
      COUNT(DISTINCT CASE WHEN e.pax_count IS NOT NULL THEN e.id END) AS total_workouts,
      ROUND(AVG(e.pax_count), 1)    AS avg_pax,
      SUM(e.pax_count)              AS total_posts
    FROM \`f3data.analytics.event_info\` e
    WHERE e.region_org_id = ${REGION_ID}
      AND e.ao_name IS NOT NULL
      AND e.pax_count IS NOT NULL
      AND e.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
    GROUP BY e.ao_name
    ORDER BY avg_pax DESC
    LIMIT 10
  `;

  const topWorkoutsSql = `
    SELECT
      e.start_date,
      e.ao_name,
      e.pax_count,
      ARRAY_AGG(a.f3_name ORDER BY a.q_ind DESC LIMIT 1)[OFFSET(0)] AS q_name
    FROM \`f3data.analytics.event_info\`      e
    JOIN \`f3data.analytics.attendance_info\` a ON a.event_instance_id = e.id
    WHERE e.region_org_id = ${REGION_ID}
      AND e.pax_count IS NOT NULL
      AND a.q_ind = 1
      AND EXTRACT(YEAR FROM e.start_date) = EXTRACT(YEAR FROM CURRENT_DATE())
      AND LOWER(e.ao_name) NOT LIKE '%convergence%'
      AND LOWER(e.ao_name) NOT LIKE '%converge%'
    GROUP BY e.start_date, e.ao_name, e.pax_count
    ORDER BY e.pax_count DESC
    LIMIT 10
  `;

  const statsRows = bqQuery(statsSql);
  const dayRows   = bqQuery(daysSql);
  const topAoRows = bqQuery(topAosSql);
  const topWkRows = bqQuery(topWorkoutsSql);

  const r = statsRows[0] || {};
  Logger.log(`Region: ${r.total_workouts} tracked / ${r.scheduled_workouts} scheduled, ${r.active_pax} PAX`);

  const attendanceByDay = dayRows.map(d => ({
    day:            d.day_name,
    total_posts:    parseInt(d.total_posts)    || 0,
    total_workouts: parseInt(d.total_workouts) || 0,
    avg_pax:        parseFloat(d.avg_pax)       || 0,
  }));

  const topAos = topAoRows.map(a => ({
    ao_name:        a.ao_name,
    total_workouts: parseInt(a.total_workouts) || 0,
    avg_pax:        parseFloat(a.avg_pax)       || 0,
    total_posts:    parseInt(a.total_posts)     || 0,
  }));

  const topWorkouts = topWkRows.map(w => ({
    date:      w.start_date,
    ao_name:   w.ao_name,
    pax_count: parseInt(w.pax_count) || 0,
    q_name:    cleanHandle(w.q_name  || ''),
  }));

  supabaseUpsert('bq_region_stats', [{
    id:                  1,
    total_workouts:      parseInt(r.total_workouts)     || 0,
    scheduled_workouts:  parseInt(r.scheduled_workouts) || 0,
    total_posts:         parseInt(r.total_posts)        || 0,
    total_pax:           parseInt(r.total_pax)          || 0,
    total_fngs:          parseInt(r.total_fngs)         || 0,
    ao_count:            parseInt(r.ao_count)           || 0,
    active_pax:          parseInt(r.active_pax)         || 0,
    avg_pax:             parseFloat(r.avg_pax)           || 0,
    unique_qs:           parseInt(r.unique_qs)           || 0,
    attendance_by_day:   JSON.stringify(attendanceByDay),
    top_aos:             JSON.stringify(topAos),
    top_workouts:        JSON.stringify(topWorkouts),
    synced_at:           new Date().toISOString(),
  }]);
  Logger.log('Region stats synced');
}

function syncAoStats() {
  Logger.log('Syncing AO stats...');

  // total_workouts = events WITH a backblast (pax_count NOT NULL). This makes avg_pax consistent with total_pax_posts.
  // scheduled_workouts = all events, including ones missing backblasts.
  const aoRows = bqQuery(`
    SELECT
      e.ao_org_id,
      e.ao_name,
      COUNT(DISTINCT CASE WHEN e.pax_count IS NOT NULL THEN e.id END)                AS total_workouts,
      COUNT(DISTINCT e.id)                                                            AS scheduled_workouts,
      ROUND(AVG(e.pax_count), 1)                                                      AS avg_pax,
      ROUND(AVG(CASE WHEN e.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
                     THEN e.pax_count END), 1)                                        AS avg_pax_recent,
      ROUND(AVG(CASE WHEN e.start_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 16 WEEK)
                                           AND DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
                     THEN e.pax_count END), 1)                                        AS avg_pax_prior,
      SUM(e.pax_count)                                                                AS total_pax_posts,
      MAX(e.start_date)                                                               AS last_workout
    FROM \`f3data.analytics.event_info\` e
    WHERE e.region_org_id = ${REGION_ID}
      AND e.ao_org_id IS NOT NULL
      AND e.ao_name IS NOT NULL
    GROUP BY e.ao_org_id, e.ao_name
    ORDER BY avg_pax_recent DESC
  `);

  const qRows = bqQuery(`
    SELECT
      e.ao_org_id,
      a.f3_name                AS handle,
      SUM(a.q_ind)             AS q_count
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID}
      AND a.q_ind = 1
      AND e.ao_org_id IS NOT NULL
    GROUP BY e.ao_org_id, a.f3_name
    QUALIFY RANK() OVER (PARTITION BY e.ao_org_id ORDER BY SUM(a.q_ind) DESC) <= 5
    ORDER BY e.ao_org_id, q_count DESC
  `);

  const weeklyRows = bqQuery(`
    SELECT
      e.ao_org_id,
      DATE_TRUNC(e.start_date, WEEK)  AS week,
      COUNT(DISTINCT CASE WHEN e.pax_count IS NOT NULL THEN e.id END)  AS workouts,
      ROUND(AVG(e.pax_count), 1)      AS avg_pax,
      SUM(e.pax_count)                AS total_pax
    FROM \`f3data.analytics.event_info\` e
    WHERE e.region_org_id = ${REGION_ID}
      AND e.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 52 WEEK)
      AND e.ao_org_id IS NOT NULL
    GROUP BY e.ao_org_id, week
    ORDER BY e.ao_org_id, week
  `);

  const topQsByAo = {};
  qRows.forEach(r => {
    const id = r.ao_org_id;
    if (!topQsByAo[id]) topQsByAo[id] = [];
    topQsByAo[id].push({ handle: cleanHandle(r.handle), q_count: parseInt(r.q_count) });
  });

  const weeklyByAo = {};
  weeklyRows.forEach(r => {
    const id = r.ao_org_id;
    if (!weeklyByAo[id]) weeklyByAo[id] = [];
    weeklyByAo[id].push({
      week:      r.week,
      workouts:  parseInt(r.workouts)   || 0,
      avg_pax:   parseFloat(r.avg_pax)  || 0,
      total_pax: parseInt(r.total_pax)  || 0,
    });
  });

  function healthStatus(recent, lastWorkout) {
    const daysSince = lastWorkout
      ? Math.floor((Date.now() - new Date(lastWorkout)) / 86400000)
      : 999;
    if (daysSince > 21)  return 'attention';
    if (recent >= 15)    return 'thriving';
    if (recent >= 10)    return 'healthy';
    if (recent >= 6)     return 'watch';
    return 'attention';
  }

  const upsertRows = aoRows.map(r => {
    const recent   = parseFloat(r.avg_pax_recent) || 0;
    const prior    = parseFloat(r.avg_pax_prior)  || 0;
    const trendPct = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 0;
    return {
      ao_org_id:          parseInt(r.ao_org_id),
      ao_name:            r.ao_name,
      total_workouts:     parseInt(r.total_workouts)     || 0,
      scheduled_workouts: parseInt(r.scheduled_workouts) || 0,
      avg_pax:            parseFloat(r.avg_pax)           || 0,
      avg_pax_recent:     recent,
      avg_pax_prior:      prior,
      trend_pct:          trendPct,
      health_status:      healthStatus(recent, r.last_workout),
      total_pax_posts:    parseInt(r.total_pax_posts)    || 0,
      last_workout:       r.last_workout || null,
      top_qs:             JSON.stringify(topQsByAo[r.ao_org_id] || []),
      weekly_data:        JSON.stringify(weeklyByAo[r.ao_org_id] || []),
      synced_at:          new Date().toISOString(),
    };
  });

  supabaseUpsert('ao_stats', upsertRows);
  Logger.log(`AO stats: ${upsertRows.length} AOs`);
}

function syncPaxAoBreakdown() {
  Logger.log('Syncing PAX-AO breakdown...');

  const rows = bqQuery(`
    SELECT
      a.user_id,
      a.f3_name         AS handle,
      e.ao_org_id,
      e.ao_name,
      COUNT(*)          AS workout_count,
      MAX(e.start_date) AS last_attended
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID}
      AND a.user_statusa = 'active'
      AND e.ao_org_id IS NOT NULL
      AND e.ao_name IS NOT NULL
    GROUP BY a.user_id, a.f3_name, e.ao_org_id, e.ao_name
    ORDER BY a.user_id, workout_count DESC
  `);

  const upsertRows = rows.map(r => ({
    pax_id:        parseInt(r.user_id),
    ao_org_id:     parseInt(r.ao_org_id),
    ao_name:       r.ao_name,
    handle:        cleanHandle(r.handle),
    workout_count: parseInt(r.workout_count) || 0,
    last_attended: r.last_attended || null,
    synced_at:     new Date().toISOString(),
  }));

  supabaseUpsert('pax_ao_breakdown', upsertRows);
  Logger.log(`PAX-AO: ${upsertRows.length} rows`);
}

function syncStatsLeaders() {
  Logger.log('Syncing stats leaders...');
  const allLeaders = [];

  const weeklyPosts = bqQuery(`
    SELECT handle, avatar_url, week, post_count FROM (
      SELECT
        a.f3_name                            AS handle,
        a.avatar_url,
        DATE_TRUNC(a.start_date, WEEK)       AS week,
        COUNT(*)                             AS post_count,
        RANK() OVER (ORDER BY COUNT(*) DESC) AS rnk
      FROM \`f3data.analytics.attendance_info\` a
      JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
      WHERE e.region_org_id = ${REGION_ID}
      GROUP BY a.f3_name, a.avatar_url, week
    ) WHERE rnk <= 10
    ORDER BY post_count DESC
  `);
  weeklyPosts.forEach((r, i) => allLeaders.push({
    category:   'most_posts_one_week',
    rank:       i + 1,
    handle:     cleanHandle(r.handle),
    avatar_url: r.avatar_url || null,
    value:      parseInt(r.post_count),
    detail:     JSON.stringify({ week: r.week }),
    synced_at:  new Date().toISOString(),
  }));

  const weeklyQs = bqQuery(`
    SELECT handle, avatar_url, week, q_count FROM (
      SELECT
        a.f3_name                                    AS handle,
        a.avatar_url,
        DATE_TRUNC(a.start_date, WEEK)               AS week,
        SUM(a.q_ind)                                 AS q_count,
        RANK() OVER (ORDER BY SUM(a.q_ind) DESC)     AS rnk
      FROM \`f3data.analytics.attendance_info\` a
      JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
      WHERE e.region_org_id = ${REGION_ID} AND a.q_ind = 1
      GROUP BY a.f3_name, a.avatar_url, week
      HAVING SUM(a.q_ind) > 1
    ) WHERE rnk <= 10
    ORDER BY q_count DESC
  `);
  weeklyQs.forEach((r, i) => allLeaders.push({
    category:   'most_qs_one_week',
    rank:       i + 1,
    handle:     cleanHandle(r.handle),
    avatar_url: r.avatar_url || null,
    value:      parseInt(r.q_count),
    detail:     JSON.stringify({ week: r.week }),
    synced_at:  new Date().toISOString(),
  }));

  const uniqueAoQs = bqQuery(`
    SELECT
      a.f3_name                   AS handle,
      a.avatar_url,
      COUNT(DISTINCT e.ao_org_id) AS unique_aos
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID}
      AND a.q_ind = 1
      AND e.ao_org_id IS NOT NULL
    GROUP BY a.f3_name, a.avatar_url
    ORDER BY unique_aos DESC
    LIMIT 10
  `);
  uniqueAoQs.forEach((r, i) => allLeaders.push({
    category:   'most_unique_ao_qs',
    rank:       i + 1,
    handle:     cleanHandle(r.handle),
    avatar_url: r.avatar_url || null,
    value:      parseInt(r.unique_aos),
    detail:     JSON.stringify({}),
    synced_at:  new Date().toISOString(),
  }));

  const singleAoPosts = bqQuery(`
    SELECT handle, avatar_url, ao_name, post_count FROM (
      SELECT
        a.f3_name                            AS handle,
        a.avatar_url,
        e.ao_name,
        COUNT(*)                             AS post_count,
        RANK() OVER (ORDER BY COUNT(*) DESC) AS rnk
      FROM \`f3data.analytics.attendance_info\` a
      JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
      WHERE e.region_org_id = ${REGION_ID}
        AND e.ao_name IS NOT NULL
      GROUP BY a.f3_name, a.avatar_url, e.ao_name
    ) WHERE rnk <= 10
    ORDER BY post_count DESC
  `);
  singleAoPosts.forEach((r, i) => allLeaders.push({
    category:   'most_posts_single_ao',
    rank:       i + 1,
    handle:     cleanHandle(r.handle),
    avatar_url: r.avatar_url || null,
    value:      parseInt(r.post_count),
    detail:     JSON.stringify({ ao_name: r.ao_name }),
    synced_at:  new Date().toISOString(),
  }));

  const streaks = bqQuery(`
    SELECT user_id, handle, avatar_url, best_streak FROM (
      WITH daily AS (
        SELECT DISTINCT
          a.user_id,
          a.f3_name AS handle,
          a.avatar_url,
          a.start_date
        FROM \`f3data.analytics.attendance_info\` a
        JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
        WHERE e.region_org_id = ${REGION_ID}
      ),
      gaps AS (
        SELECT *,
          DATE_DIFF(start_date,
            LAG(start_date) OVER (PARTITION BY user_id ORDER BY start_date),
            DAY) AS gap
        FROM daily
      ),
      streak_groups AS (
        SELECT *,
          SUM(CASE WHEN gap > 1 OR gap IS NULL THEN 1 ELSE 0 END)
            OVER (PARTITION BY user_id ORDER BY start_date) AS grp
        FROM gaps
      ),
      streak_lengths AS (
        SELECT user_id, handle, avatar_url, grp, COUNT(*) AS streak_len
        FROM streak_groups
        GROUP BY user_id, handle, avatar_url, grp
      )
      SELECT user_id, handle, avatar_url, MAX(streak_len) AS best_streak
      FROM streak_lengths
      GROUP BY user_id, handle, avatar_url
    )
    ORDER BY best_streak DESC
    LIMIT 10
  `);
  streaks.forEach((r, i) => allLeaders.push({
    category:   'longest_streak',
    rank:       i + 1,
    handle:     cleanHandle(r.handle),
    avatar_url: r.avatar_url || null,
    value:      parseInt(r.best_streak),
    detail:     JSON.stringify({}),
    synced_at:  new Date().toISOString(),
  }));

  // Clear stale ranks first so a shorter category this run can't leave orphans.
  clearTable('stats_leaders', 'category');
  supabaseUpsert('stats_leaders', allLeaders);
  Logger.log(`Stats leaders: ${allLeaders.length} rows`);
}

function syncKotterList() {
  Logger.log('Syncing Kotter list...');

  const rows = bqQuery(`
    SELECT * FROM (
      WITH
      recent AS (
        SELECT a.user_id, COUNT(*) AS posts_recent
        FROM \`f3data.analytics.attendance_info\` a
        JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
        WHERE e.region_org_id = ${REGION_ID}
          AND a.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 4 WEEK)
        GROUP BY a.user_id
      ),
      prior AS (
        SELECT a.user_id, COUNT(*) AS posts_prior
        FROM \`f3data.analytics.attendance_info\` a
        JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
        WHERE e.region_org_id = ${REGION_ID}
          AND a.start_date BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 8 WEEK)
                                AND DATE_SUB(CURRENT_DATE(), INTERVAL 4 WEEK)
        GROUP BY a.user_id
      ),
      totals AS (
        SELECT
          a.user_id,
          a.f3_name                                                             AS handle,
          a.avatar_url,
          COUNT(*)                                                              AS total_posts,
          MAX(a.start_date)                                                     AS last_post,
          ARRAY_AGG(e.ao_name ORDER BY a.start_date DESC LIMIT 1)[OFFSET(0)]   AS last_ao
        FROM \`f3data.analytics.attendance_info\` a
        JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
        WHERE e.region_org_id = ${REGION_ID}
        GROUP BY a.user_id, a.f3_name, a.avatar_url
      )
      SELECT
        t.user_id,
        t.handle,
        t.avatar_url,
        t.total_posts,
        t.last_post,
        t.last_ao,
        DATE_DIFF(CURRENT_DATE(), t.last_post, DAY)  AS days_since,
        COALESCE(r.posts_recent, 0)                   AS posts_recent_4wk,
        COALESCE(p.posts_prior,  0)                   AS posts_prior_4wk,
        CASE
          WHEN t.total_posts BETWEEN 1 AND 5
            AND DATE_DIFF(CURRENT_DATE(), t.last_post, DAY) >= 14
            THEN 'new_drop'
          WHEN DATE_DIFF(CURRENT_DATE(), t.last_post, DAY) >= 60
            AND DATE_DIFF(CURRENT_DATE(), t.last_post, DAY) < 180
            AND t.total_posts >= 10
            THEN 'inactive'
          WHEN DATE_DIFF(CURRENT_DATE(), t.last_post, DAY) >= 21
            AND COALESCE(r.posts_recent, 0) < COALESCE(p.posts_prior, 0) * 0.5
            AND COALESCE(p.posts_prior, 0) >= 4
            THEN 'fading'
          WHEN DATE_DIFF(CURRENT_DATE(), t.last_post, DAY) <= 14
            AND COALESCE(p.posts_prior, 0) = 0
            AND t.total_posts >= 5
            THEN 'returning'
          ELSE NULL
        END AS kotter_status
      FROM totals t
      LEFT JOIN recent r ON r.user_id = t.user_id
      LEFT JOIN prior  p ON p.user_id = t.user_id
    )
    WHERE kotter_status IS NOT NULL
    ORDER BY days_since DESC
  `);

  const upsertRows = rows.map(r => ({
    pax_id:           parseInt(r.user_id),
    handle:           cleanHandle(r.handle),
    avatar_url:       r.avatar_url           || null,
    total_posts:      parseInt(r.total_posts)      || 0,
    last_post:        r.last_post            || null,
    last_ao:          r.last_ao              || null,
    days_since:       parseInt(r.days_since)       || 0,
    posts_recent_4wk: parseInt(r.posts_recent_4wk) || 0,
    posts_prior_4wk:  parseInt(r.posts_prior_4wk)  || 0,
    kotter_status:    r.kotter_status,
    synced_at:        new Date().toISOString(),
  }));

  // Clear first: a PAX who recovered should drop OFF the at-risk list, not linger.
  clearTable('kotter_list', 'pax_id');
  supabaseUpsert('kotter_list', upsertRows);
  Logger.log(`Kotter list: ${upsertRows.length} PAX flagged`);
}

function syncScheduledQs() {
  Logger.log('Syncing scheduled Qs...');

  const today = new Date().toISOString().split('T')[0];
  const url = `https://api.f3nation.com/v1/event-instance/calendar-home-schedule`
    + `?regionOrgId=${REGION_ID}&userId=1&startDate=${today}&limit=200`;

  const resp = UrlFetchApp.fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + F3_NATION_TOKEN,
      'client': 'f3-snacktown',
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  const events = (data.events || []).filter(e => e.plannedQs);

  if (!events.length) { Logger.log('No scheduled Qs found'); return; }

  const rows = events.map(e => ({
    event_instance_id: e.id,
    ao_name:           e.orgName || e.name,
    start_date:        e.startDate,
    start_time:        e.startTime || null,
    planned_q:         e.plannedQs,
    org_id:            e.orgId,
    synced_at:         new Date().toISOString(),
  }));

  supabaseUpsert('scheduled_qs', rows);
  Logger.log('Scheduled Qs synced: ' + rows.length + ' events with Qs');
}

function syncTravelData() {
  Logger.log('Syncing travel data...');

  const rows = bqQuery(`
    SELECT
      e.location_name,
      e.location_latitude  AS latitude,
      e.location_longitude AS longitude,
      e.region_name,
      COUNT(DISTINCT a.user_id) AS pax_count,
      COUNT(*)                  AS total_posts
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE a.user_id IN (
      SELECT DISTINCT a2.user_id
      FROM \`f3data.analytics.attendance_info\` a2
      JOIN \`f3data.analytics.event_info\`      e2 ON e2.id = a2.event_instance_id
      WHERE e2.region_org_id = ${REGION_ID}
    )
    AND e.region_org_id != ${REGION_ID}
    AND e.location_latitude  IS NOT NULL
    AND e.location_name      IS NOT NULL
    AND TRIM(e.location_name) != ''
    GROUP BY e.location_name, e.location_latitude, e.location_longitude, e.region_name
    ORDER BY pax_count DESC
  `);

  if (!rows.length) { Logger.log('No travel rows'); return; }

  const formatted = rows.map(r => ({
    location_name: r.location_name,
    latitude:      parseFloat(r.latitude)   || 0,
    longitude:     parseFloat(r.longitude)  || 0,
    region_name:   r.region_name            || '',
    pax_count:     parseInt(r.pax_count)    || 1,
    total_posts:   parseInt(r.total_posts)  || 1,
    synced_at:     new Date().toISOString(),
  }));

  // PostgREST requires a filter on DELETE — fully replace the table each run.
  clearTable('travel_locations', 'location_name');
  supabaseUpsert('travel_locations', formatted);
  Logger.log('Travel data: ' + formatted.length + ' locations');
}

// Incremental — only last 14 days. Older days don't change so we don't re-upload them.
function syncPaxActivity() {
  Logger.log('Syncing PAX activity (last 14 days)...');

  const sql = `
    SELECT
      a.user_id                  AS pax_id,
      e.start_date               AS post_date,
      COUNT(*)                   AS post_count,
      SUM(a.q_ind)               AS q_count,
      TO_JSON_STRING(ARRAY_AGG(STRUCT(
        e.id           AS id,
        e.ao_name      AS ao_name,
        (a.q_ind = 1)  AS is_q
      )))                        AS events_json
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID}
      AND e.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
    GROUP BY a.user_id, e.start_date
  `;

  const rows = bqQuery(sql);
  if (!rows.length) { Logger.log('No activity rows'); return; }

  const formatted = rows.map(r => ({
    pax_id:     parseInt(r.pax_id),
    post_date:  r.post_date,
    post_count: parseInt(r.post_count) || 1,
    q_count:    parseInt(r.q_count)    || 0,
    events:     JSON.parse(r.events_json || '[]'),
  }));

  supabaseUpsert('pax_activity', formatted);
  Logger.log('PAX activity: ' + formatted.length + ' rows (last 14 days)');
}

// ONE-TIME: pulls a full year of history to backfill the activity heatmap.
// Run this ONCE from the editor after the first syncAll.
function backfillPaxActivity() {
  Logger.log('Backfilling PAX activity (1 year)...');

  const sql = `
    SELECT
      a.user_id                  AS pax_id,
      e.start_date               AS post_date,
      COUNT(*)                   AS post_count,
      SUM(a.q_ind)               AS q_count,
      TO_JSON_STRING(ARRAY_AGG(STRUCT(
        e.id           AS id,
        e.ao_name      AS ao_name,
        (a.q_ind = 1)  AS is_q
      )))                        AS events_json
    FROM \`f3data.analytics.attendance_info\` a
    JOIN \`f3data.analytics.event_info\`      e ON e.id = a.event_instance_id
    WHERE e.region_org_id = ${REGION_ID}
      AND e.start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 1 YEAR)
    GROUP BY a.user_id, e.start_date
  `;

  const rows = bqQuery(sql);
  Logger.log('Query returned ' + rows.length + ' rows');

  const formatted = rows.map(r => ({
    pax_id:     parseInt(r.pax_id),
    post_date:  r.post_date,
    post_count: parseInt(r.post_count) || 1,
    q_count:    parseInt(r.q_count)    || 0,
    events:     JSON.parse(r.events_json || '[]'),
  }));

  supabaseUpsert('pax_activity', formatted);
  Logger.log('Backfill complete: ' + formatted.length + ' rows');
}

// Daily — every morning at 5am ET after setupTriggers().
function syncDaily() {
  syncPaxStats();
  syncRegionStats();
  syncAoStats();
  syncKotterList();
  syncScheduledQs();
  syncPaxActivity();
  Logger.log('Daily sync complete');
}

// Weekly — Sunday 2am ET after setupTriggers(). Heavier / slow-changing tables.
function syncWeekly() {
  syncPaxAoBreakdown();
  syncStatsLeaders();
  syncTravelData();
  Logger.log('Weekly sync complete');
}

// Manual catch-all — runs everything. Fine for testing / first run.
function syncAll() {
  syncPaxStats();
  syncRegionStats();
  syncAoStats();
  syncPaxAoBreakdown();
  syncStatsLeaders();
  syncKotterList();
  syncScheduledQs();
  syncTravelData();
  syncPaxActivity();
  Logger.log('All syncs complete');
}

// Run ONCE from the editor to install the daily + weekly triggers.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncDaily')
    .timeBased().atHour(5).everyDays(1).inTimezone('America/New_York').create();
  ScriptApp.newTrigger('syncWeekly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).inTimezone('America/New_York').create();
  Logger.log('Triggers installed: syncDaily 5am ET, syncWeekly Sunday 2am ET');
}
