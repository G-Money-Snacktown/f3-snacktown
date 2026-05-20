-- ══════════════════════════════════════════════════════════════
-- F3 Snacktown — BigQuery Analytics Migration
-- Run in Supabase SQL Editor AFTER migration.sql.
--
-- Creates the tables that the BigQuery → Supabase Apps Script
-- (bigquery-sync/AppsScript.gs) writes into. These hold the richer,
-- pre-computed analytics that the API-fed SQL views can't produce:
-- streaks, weekly leaderboards, AO trend/health, Kotter at-risk list,
-- daily activity heatmap, and cross-region travel.
--
-- These tables COEXIST with the v_* views from migration.sql:
--   view  v_pax_stats      ←→  table pax_stats        (BQ-fed, richer)
--   view  v_ao_stats       ←→  table ao_stats         (BQ-fed, richer)
--   view  v_region_stats   ←→  table bq_region_stats  (BQ-fed, richer)
--   view  v_pax_activity   ←→  table pax_activity     (BQ-fed, + q_count/events)
-- The front end is pointed at the BQ tables when present; the views
-- remain as an API-only fallback.
--
-- Safe to re-run (IF NOT EXISTS).
-- ══════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────
-- 1. PUBLIC ANALYTICS TABLES (anon-readable)
-- ──────────────────────────────────────────────────────────────

-- Per-PAX career + YTD stats. Written by syncPaxStats().
CREATE TABLE IF NOT EXISTS pax_stats (
  pax_id            INTEGER PRIMARY KEY,
  handle            TEXT,
  avatar_url        TEXT,
  workout_count     INTEGER DEFAULT 0,
  workout_count_ytd INTEGER DEFAULT 0,
  q_count           INTEGER DEFAULT 0,
  q_count_ytd       INTEGER DEFAULT 0,
  coq_count         INTEGER DEFAULT 0,
  last_attended     DATE,
  home_ao           TEXT,
  rank              INTEGER,
  is_active_roster  BOOLEAN DEFAULT FALSE,
  synced_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Single-row (id=1) region rollup + embedded JSON blocks.
-- Written by syncRegionStats().
CREATE TABLE IF NOT EXISTS bq_region_stats (
  id                 INTEGER PRIMARY KEY,        -- always 1
  total_workouts     INTEGER DEFAULT 0,          -- events WITH a backblast
  scheduled_workouts INTEGER DEFAULT 0,          -- all events
  total_posts        INTEGER DEFAULT 0,
  total_pax          INTEGER DEFAULT 0,
  total_fngs         INTEGER DEFAULT 0,
  ao_count           INTEGER DEFAULT 0,
  active_pax         INTEGER DEFAULT 0,
  avg_pax            NUMERIC DEFAULT 0,
  unique_qs          INTEGER DEFAULT 0,
  attendance_by_day  JSONB DEFAULT '[]',
  top_aos            JSONB DEFAULT '[]',
  top_workouts       JSONB DEFAULT '[]',
  synced_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Per-AO stats incl. recent-vs-prior trend + health classification.
-- Written by syncAoStats().
CREATE TABLE IF NOT EXISTS ao_stats (
  ao_org_id          INTEGER PRIMARY KEY,
  ao_name            TEXT,
  total_workouts     INTEGER DEFAULT 0,
  scheduled_workouts INTEGER DEFAULT 0,
  avg_pax            NUMERIC DEFAULT 0,
  avg_pax_recent     NUMERIC DEFAULT 0,          -- last 8 weeks
  avg_pax_prior      NUMERIC DEFAULT 0,          -- weeks 8–16 ago
  trend_pct          INTEGER DEFAULT 0,          -- % change recent vs prior
  health_status      TEXT,                        -- thriving|healthy|watch|attention
  total_pax_posts    INTEGER DEFAULT 0,
  last_workout       DATE,
  top_qs             JSONB DEFAULT '[]',
  weekly_data        JSONB DEFAULT '[]',          -- last 52 weeks
  synced_at          TIMESTAMPTZ DEFAULT NOW()
);

-- One row per PAX per AO they post at. Written by syncPaxAoBreakdown().
CREATE TABLE IF NOT EXISTS pax_ao_breakdown (
  pax_id        INTEGER NOT NULL,
  ao_org_id     INTEGER NOT NULL,
  ao_name       TEXT,
  handle        TEXT,
  workout_count INTEGER DEFAULT 0,
  last_attended DATE,
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (pax_id, ao_org_id)
);

-- Leaderboard records across categories. Written by syncStatsLeaders().
-- category ∈ {most_posts_one_week, most_qs_one_week, most_unique_ao_qs,
--             most_posts_single_ao, longest_streak}
CREATE TABLE IF NOT EXISTS stats_leaders (
  category   TEXT    NOT NULL,
  rank       INTEGER NOT NULL,
  handle     TEXT,
  avatar_url TEXT,
  value      INTEGER,
  detail     JSONB DEFAULT '{}',          -- e.g. {"week":...} or {"ao_name":...}
  synced_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (category, rank)
);

-- Daily post counts per PAX (activity heatmap). Written by syncPaxActivity().
CREATE TABLE IF NOT EXISTS pax_activity (
  pax_id     INTEGER NOT NULL,
  post_date  DATE    NOT NULL,
  post_count INTEGER DEFAULT 1,
  q_count    INTEGER DEFAULT 0,
  events     JSONB DEFAULT '[]',          -- [{id, ao_name, is_q}, ...]
  PRIMARY KEY (pax_id, post_date)
);

-- Planned Qs from F3 Nation calendar-home-schedule. Written by syncScheduledQs().
CREATE TABLE IF NOT EXISTS scheduled_qs (
  event_instance_id INTEGER PRIMARY KEY,
  ao_name           TEXT,
  start_date        DATE,
  start_time        TEXT,
  planned_q         TEXT,
  org_id            INTEGER,
  synced_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Where Snacktown PAX post when they travel to OTHER regions.
-- Fully replaced each weekly run (delete-then-insert). Written by syncTravelData().
CREATE TABLE IF NOT EXISTS travel_locations (
  id            BIGSERIAL PRIMARY KEY,
  location_name TEXT NOT NULL,
  latitude      NUMERIC DEFAULT 0,
  longitude     NUMERIC DEFAULT 0,
  region_name   TEXT DEFAULT '',
  pax_count     INTEGER DEFAULT 1,
  total_posts   INTEGER DEFAULT 1,
  synced_at     TIMESTAMPTZ DEFAULT NOW()
);


-- ──────────────────────────────────────────────────────────────
-- 2. SENSITIVE TABLE (service-role only — NO anon read)
-- ──────────────────────────────────────────────────────────────

-- "PAX at risk" list. INTERNAL: this names men who may be drifting away.
-- It must never be exposed to the public anon key — serve it only through
-- an admin-authenticated Netlify function. Written by syncKotterList().
-- kotter_status ∈ {new_drop, inactive, fading, returning}
CREATE TABLE IF NOT EXISTS kotter_list (
  pax_id           INTEGER PRIMARY KEY,
  handle           TEXT,
  avatar_url       TEXT,
  total_posts      INTEGER DEFAULT 0,
  last_post        DATE,
  last_ao          TEXT,
  days_since       INTEGER DEFAULT 0,
  posts_recent_4wk INTEGER DEFAULT 0,
  posts_prior_4wk  INTEGER DEFAULT 0,
  kotter_status    TEXT,
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);


-- ──────────────────────────────────────────────────────────────
-- 3. INDEXES
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pax_stats_rank      ON pax_stats(rank);
CREATE INDEX IF NOT EXISTS idx_ao_stats_health     ON ao_stats(health_status);
CREATE INDEX IF NOT EXISTS idx_pax_ao_pax          ON pax_ao_breakdown(pax_id);
CREATE INDEX IF NOT EXISTS idx_pax_ao_ao           ON pax_ao_breakdown(ao_org_id);
CREATE INDEX IF NOT EXISTS idx_leaders_category    ON stats_leaders(category);
CREATE INDEX IF NOT EXISTS idx_activity_date       ON pax_activity(post_date);
CREATE INDEX IF NOT EXISTS idx_kotter_status       ON kotter_list(kotter_status);


-- ──────────────────────────────────────────────────────────────
-- 4. ROW LEVEL SECURITY
-- ──────────────────────────────────────────────────────────────

ALTER TABLE pax_stats        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bq_region_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ao_stats         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax_ao_breakdown ENABLE ROW LEVEL SECURITY;
ALTER TABLE stats_leaders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE pax_activity     ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_qs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kotter_list      ENABLE ROW LEVEL SECURITY;

-- Public read on the non-sensitive analytics tables
CREATE POLICY "anon_read_pax_stats"        ON pax_stats        FOR SELECT USING (true);
CREATE POLICY "anon_read_bq_region_stats"  ON bq_region_stats  FOR SELECT USING (true);
CREATE POLICY "anon_read_ao_stats"         ON ao_stats         FOR SELECT USING (true);
CREATE POLICY "anon_read_pax_ao_breakdown" ON pax_ao_breakdown FOR SELECT USING (true);
CREATE POLICY "anon_read_stats_leaders"    ON stats_leaders    FOR SELECT USING (true);
CREATE POLICY "anon_read_pax_activity"     ON pax_activity     FOR SELECT USING (true);
CREATE POLICY "anon_read_scheduled_qs"     ON scheduled_qs     FOR SELECT USING (true);
CREATE POLICY "anon_read_travel_locations" ON travel_locations FOR SELECT USING (true);
-- NOTE: deliberately NO anon read policy on kotter_list.

-- Service role full access (Apps Script writer + admin-only Netlify functions)
CREATE POLICY "service_all_pax_stats"        ON pax_stats        FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_bq_region_stats"  ON bq_region_stats  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_ao_stats"         ON ao_stats         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_pax_ao_breakdown" ON pax_ao_breakdown FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_stats_leaders"    ON stats_leaders    FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_pax_activity"     ON pax_activity     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_scheduled_qs"     ON scheduled_qs     FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_travel_locations" ON travel_locations FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_all_kotter_list"      ON kotter_list      FOR ALL TO service_role USING (true) WITH CHECK (true);
