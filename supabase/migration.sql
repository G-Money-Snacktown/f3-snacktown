-- ══════════════════════════════════════════════════════════════
-- F3 Region PAX Data — Supabase Migration
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- Creates all tables, indexes, views, and RLS policies needed
-- for the PAX vault, leaderboard, region stats, and admin features.
--
-- Safe to re-run (uses IF NOT EXISTS / CREATE OR REPLACE).
-- ══════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────
-- 1. CORE TABLES
-- ──────────────────────────────────────────────────────────────

-- AO locations from F3 Nation API /map/location/events-and-locations
CREATE TABLE IF NOT EXISTS f3_locations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  lat           NUMERIC,
  lon           NUMERIC,
  address       TEXT,
  logo_url      TEXT,
  org_id        INTEGER,
  schedule      JSONB DEFAULT '[]',    -- weekly schedule array
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Raw workout event instances from F3 Nation API /event-instance
CREATE TABLE IF NOT EXISTS f3_event_instances (
  id            INTEGER PRIMARY KEY,
  name          TEXT,
  description   TEXT,
  start_date    DATE NOT NULL,
  end_date      DATE,
  start_time    TEXT,                   -- "0530" format
  end_time      TEXT,
  location_id   INTEGER REFERENCES f3_locations(id) ON DELETE SET NULL,
  org_id        INTEGER,
  series_id     INTEGER,
  pax_count     INTEGER DEFAULT 0,
  fng_count     INTEGER DEFAULT 0,
  q_name        TEXT,
  co_q_names    JSONB DEFAULT '[]',    -- ["Handle1", "Handle2"]
  event_type    TEXT,
  event_type_id INTEGER,
  is_active     BOOLEAN DEFAULT TRUE,
  backblast     TEXT,
  meta          JSONB DEFAULT '{}',    -- eventTypes, eventTags arrays
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- PAX user profiles from F3 Nation API /attendance response
CREATE TABLE IF NOT EXISTS f3_users (
  id            INTEGER PRIMARY KEY,   -- F3 Nation userId
  f3_name       TEXT NOT NULL,
  avatar_url    TEXT,
  home_region_id INTEGER,
  meta          JSONB DEFAULT '{}',
  first_seen    DATE,
  last_seen     DATE,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Normalized attendance: one row per PAX per event
-- Populated by calling /attendance/event-instance/{id} per event
CREATE TABLE IF NOT EXISTS f3_attendance (
  event_instance_id  INTEGER NOT NULL REFERENCES f3_event_instances(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES f3_users(id) ON DELETE CASCADE,
  attendance_type    TEXT DEFAULT 'PAX',  -- 'PAX', 'Q', 'Co-Q'
  synced_at          TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (event_instance_id, user_id)
);


-- ──────────────────────────────────────────────────────────────
-- 2. ADMIN / OVERRIDE TABLES
-- ──────────────────────────────────────────────────────────────

-- Admin-editable PAX fields (bio, position, photo, video)
CREATE TABLE IF NOT EXISTS pax_overrides (
  pax_id        INTEGER PRIMARY KEY REFERENCES f3_users(id) ON DELETE CASCADE,
  position      TEXT,
  bio           TEXT,
  photo_url     TEXT,
  video_url     TEXT,
  display_order INTEGER DEFAULT 999,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Short-lived admin auth tokens (replaces WP transients)
CREATE TABLE IF NOT EXISTS admin_tokens (
  token         TEXT PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  ip_hash       TEXT
);

-- Admin configuration (passcode hash, settings)
CREATE TABLE IF NOT EXISTS admin_config (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Sync state tracking with resume capability
CREATE TABLE IF NOT EXISTS sync_metadata (
  id              SERIAL PRIMARY KEY,
  sync_type       TEXT NOT NULL,          -- 'full', 'incremental', 'resume'
  status          TEXT DEFAULT 'running', -- 'running', 'completed', 'failed', 'paused'
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  last_page       INTEGER DEFAULT 0,      -- resume pointer for event pagination
  last_event_id   INTEGER DEFAULT 0,      -- resume pointer for attendance fetching
  events_synced   INTEGER DEFAULT 0,
  attendance_synced INTEGER DEFAULT 0,
  errors          JSONB DEFAULT '[]',
  log             JSONB DEFAULT '{}'
);


-- ──────────────────────────────────────────────────────────────
-- 3. INDEXES
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ei_date       ON f3_event_instances(start_date);
CREATE INDEX IF NOT EXISTS idx_ei_org        ON f3_event_instances(org_id);
CREATE INDEX IF NOT EXISTS idx_ei_loc        ON f3_event_instances(location_id);
CREATE INDEX IF NOT EXISTS idx_att_user      ON f3_attendance(user_id);
CREATE INDEX IF NOT EXISTS idx_att_event     ON f3_attendance(event_instance_id);
CREATE INDEX IF NOT EXISTS idx_att_type      ON f3_attendance(attendance_type);
CREATE INDEX IF NOT EXISTS idx_users_name    ON f3_users(f3_name);
CREATE INDEX IF NOT EXISTS idx_users_seen    ON f3_users(last_seen);
CREATE INDEX IF NOT EXISTS idx_tokens_exp    ON admin_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_sync_status   ON sync_metadata(status);


-- ──────────────────────────────────────────────────────────────
-- 4. SQL VIEWS (computed on read from raw data)
-- ──────────────────────────────────────────────────────────────

-- v_pax_stats: per-PAX aggregated statistics
-- Mirrors Waxhaw's pax_stats table but computed live
CREATE OR REPLACE VIEW v_pax_stats AS
SELECT
  u.id AS pax_id,
  u.f3_name AS handle,
  u.avatar_url,
  u.first_seen,
  u.last_seen,
  -- Workout counts
  COUNT(DISTINCT a.event_instance_id) AS workout_count,
  COUNT(DISTINCT a.event_instance_id) FILTER (
    WHERE e.start_date >= date_trunc('year', CURRENT_DATE)
  ) AS workout_count_ytd,
  -- Q counts
  COUNT(DISTINCT a.event_instance_id) FILTER (
    WHERE a.attendance_type = 'Q'
  ) AS q_count,
  COUNT(DISTINCT a.event_instance_id) FILTER (
    WHERE a.attendance_type = 'Q'
    AND e.start_date >= date_trunc('year', CURRENT_DATE)
  ) AS q_count_ytd,
  -- Co-Q count
  COUNT(DISTINCT a.event_instance_id) FILTER (
    WHERE a.attendance_type = 'Co-Q'
  ) AS coq_count,
  -- Home AO: org_id where they post most
  (
    SELECT e2.org_id
    FROM f3_attendance a2
    JOIN f3_event_instances e2 ON e2.id = a2.event_instance_id
    WHERE a2.user_id = u.id
    GROUP BY e2.org_id
    ORDER BY COUNT(*) DESC
    LIMIT 1
  ) AS home_ao_id,
  -- Active roster: posted in last 90 days
  (u.last_seen >= CURRENT_DATE - INTERVAL '90 days') AS is_active_roster,
  -- Override fields (merged in)
  po.position,
  po.bio,
  po.photo_url AS override_photo_url,
  po.video_url,
  po.display_order
FROM f3_users u
LEFT JOIN f3_attendance a ON a.user_id = u.id
LEFT JOIN f3_event_instances e ON e.id = a.event_instance_id
LEFT JOIN pax_overrides po ON po.pax_id = u.id
GROUP BY u.id, u.f3_name, u.avatar_url, u.first_seen, u.last_seen,
         po.position, po.bio, po.photo_url, po.video_url, po.display_order;


-- v_ao_stats: per-AO aggregated statistics
CREATE OR REPLACE VIEW v_ao_stats AS
WITH ao_events AS (
  SELECT
    e.org_id AS ao_org_id,
    MAX(e.name) AS ao_name,
    COUNT(e.id) AS total_events,
    ROUND(AVG(e.pax_count)::NUMERIC, 1) AS avg_pax_all_time,
    ROUND(AVG(e.pax_count) FILTER (
      WHERE e.start_date >= CURRENT_DATE - INTERVAL '30 days'
    )::NUMERIC, 1) AS avg_pax_recent,
    MAX(e.start_date) AS last_event_date
  FROM f3_event_instances e
  WHERE e.is_active = true AND e.org_id IS NOT NULL
  GROUP BY e.org_id
),
ao_top_qs AS (
  SELECT
    e.org_id,
    jsonb_agg(
      jsonb_build_object('handle', sub.handle, 'count', sub.cnt)
      ORDER BY sub.cnt DESC
    ) AS top_qs
  FROM (
    SELECT
      e2.org_id,
      u.f3_name AS handle,
      COUNT(*) AS cnt
    FROM f3_attendance a
    JOIN f3_users u ON u.id = a.user_id
    JOIN f3_event_instances e2 ON e2.id = a.event_instance_id
    WHERE a.attendance_type = 'Q' AND e2.org_id IS NOT NULL
    GROUP BY e2.org_id, u.f3_name
  ) sub
  JOIN f3_event_instances e ON e.org_id = sub.org_id
  GROUP BY e.org_id
)
SELECT
  ae.ao_org_id,
  ae.ao_name,
  ae.total_events,
  ae.avg_pax_all_time,
  ae.avg_pax_recent,
  ae.last_event_date,
  COALESCE(aq.top_qs, '[]'::jsonb) AS top_qs
FROM ao_events ae
LEFT JOIN ao_top_qs aq ON aq.org_id = ae.ao_org_id;


-- v_region_stats: single-row region-level aggregates
CREATE OR REPLACE VIEW v_region_stats AS
SELECT
  (SELECT COUNT(DISTINCT id) FROM f3_users
   WHERE last_seen >= CURRENT_DATE - INTERVAL '90 days'
  ) AS active_pax_count,
  (SELECT COUNT(DISTINCT id) FROM f3_users) AS total_pax_count,
  (SELECT COUNT(*) FROM f3_event_instances
   WHERE is_active = true
  ) AS total_events,
  (SELECT COUNT(*) FROM f3_event_instances
   WHERE is_active = true
   AND start_date >= date_trunc('year', CURRENT_DATE)
  ) AS events_ytd,
  (SELECT ROUND(AVG(pax_count)::NUMERIC, 1) FROM f3_event_instances
   WHERE start_date >= CURRENT_DATE - INTERVAL '30 days'
   AND is_active = true
  ) AS avg_pax_30d,
  -- Attendance by day of week
  (SELECT jsonb_object_agg(day_name, avg_count)
   FROM (
     SELECT
       trim(to_char(start_date, 'Day')) AS day_name,
       ROUND(AVG(pax_count)::NUMERIC, 1) AS avg_count
     FROM f3_event_instances
     WHERE start_date >= CURRENT_DATE - INTERVAL '90 days'
       AND is_active = true
     GROUP BY trim(to_char(start_date, 'Day')),
              EXTRACT(dow FROM start_date)
     ORDER BY EXTRACT(dow FROM start_date)
   ) sub
  ) AS attendance_by_day,
  -- Top AOs by recent avg attendance
  (SELECT jsonb_agg(jsonb_build_object('name', ao_name, 'avg_pax', avg_pax))
   FROM (
     SELECT
       MAX(name) AS ao_name,
       ROUND(AVG(pax_count)::NUMERIC, 1) AS avg_pax
     FROM f3_event_instances
     WHERE start_date >= CURRENT_DATE - INTERVAL '30 days'
       AND is_active = true AND org_id IS NOT NULL
     GROUP BY org_id
     ORDER BY avg_pax DESC
     LIMIT 5
   ) sub
  ) AS top_aos;


-- v_pax_activity: daily post counts per PAX (for monthly leaderboard)
CREATE OR REPLACE VIEW v_pax_activity AS
SELECT
  a.user_id AS pax_id,
  e.start_date AS post_date,
  COUNT(*) AS post_count
FROM f3_attendance a
JOIN f3_event_instances e ON e.id = a.event_instance_id
GROUP BY a.user_id, e.start_date;


-- ──────────────────────────────────────────────────────────────
-- 5. ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE f3_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE f3_event_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE f3_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE f3_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_metadata ENABLE ROW LEVEL SECURITY;

-- Public read on data tables (anon key can read)
CREATE POLICY "anon_read_locations"  ON f3_locations       FOR SELECT USING (true);
CREATE POLICY "anon_read_events"     ON f3_event_instances FOR SELECT USING (true);
CREATE POLICY "anon_read_users"      ON f3_users           FOR SELECT USING (true);
CREATE POLICY "anon_read_attendance" ON f3_attendance       FOR SELECT USING (true);
CREATE POLICY "anon_read_overrides"  ON pax_overrides      FOR SELECT USING (true);

-- Service role full access on all tables (used by Netlify Functions)
CREATE POLICY "service_all_locations"  ON f3_locations       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_events"     ON f3_event_instances FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_users"      ON f3_users           FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_attendance" ON f3_attendance       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_overrides"  ON pax_overrides      FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_tokens"     ON admin_tokens       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_config"     ON admin_config       FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_sync"       ON sync_metadata      FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ──────────────────────────────────────────────────────────────
-- 6. HELPER FUNCTION: cleanup expired admin tokens
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  DELETE FROM admin_tokens WHERE expires_at < NOW();
$$;
