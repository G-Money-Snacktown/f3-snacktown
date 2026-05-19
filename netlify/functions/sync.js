/**
 * F3 Region Data Sync — Netlify Scheduled Function
 *
 * Pulls event instances + attendees from F3 Nation API into Supabase.
 * Runs nightly on schedule (configured in netlify.toml) or triggered manually.
 *
 * Modes:
 *   - Incremental (nightly): only events since last completed sync
 *   - Full (initial): all available history, with chunked resume
 *   - Resume: picks up a paused sync where it left off
 *
 * The sync stores raw data; SQL views compute all aggregates.
 *
 * Modeled after f3waxhaw/live/f3-nation-sync.php
 */

const {
  supabaseGet,
  supabaseUpsert,
  supabasePatch,
  f3ApiGet,
  F3_REGION_ORG_ID,
  jsonResponse,
  errorResponse,
  corsResponse,
  RateLimiter,
  CORS_HEADERS,
} = require('./lib/supabase');

const PAGE_SIZE = 300;   // F3 Nation API max per page
const MAX_PAGES = 30;    // Safety cap: 30 x 300 = 9,000 events
const ATTENDANCE_BATCH = 50; // Process attendance in batches of 50
const TIME_LIMIT_MS = 14 * 60 * 1000; // 14 min (background fn limit ~15 min)
const PAUSE_BETWEEN_CALLS_MS = 50;     // 50ms pause between calls (good citizen)

const rateLimiter = new RateLimiter(180, 60000); // 180 req/min (buffer under 200 limit)

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return corsResponse();

  const startTime = Date.now();
  const log = { started_at: new Date().toISOString(), calls: [], errors: [] };
  let syncId = null;

  try {
    // ── Check for paused sync to resume ──
    const paused = await supabaseGet('sync_metadata',
      '?status=eq.paused&order=started_at.desc&limit=1'
    );

    let mode = 'incremental';
    let lastSyncDate = null;
    let resumeEventId = 0;
    let eventIds = [];

    if (paused.length > 0) {
      // Resume a paused sync
      mode = 'resume';
      syncId = paused[0].id;
      resumeEventId = paused[0].last_event_id || 0;
      log.resuming_from = resumeEventId;

      await supabasePatch('sync_metadata', `?id=eq.${syncId}`, { status: 'running' });

      // Get event IDs that still need attendance fetched
      const events = await supabaseGet('f3_event_instances',
        `?id=gt.${resumeEventId}&order=id.asc&select=id`
      );
      eventIds = events.map(e => e.id);

    } else {
      // Determine if this is full or incremental
      const lastSync = await supabaseGet('sync_metadata',
        '?status=eq.completed&order=finished_at.desc&limit=1'
      );

      if (lastSync.length > 0) {
        mode = 'incremental';
        // Go back 7 days from last sync to catch any late-updated events
        const lastDate = new Date(lastSync[0].finished_at);
        lastDate.setDate(lastDate.getDate() - 7);
        lastSyncDate = lastDate.toISOString().split('T')[0];
      } else {
        mode = 'full';
        // Go back 2 years for full sync
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        lastSyncDate = twoYearsAgo.toISOString().split('T')[0];
      }

      // Create sync metadata row
      const syncRow = [{
        sync_type: mode,
        status: 'running',
        started_at: new Date().toISOString(),
      }];
      await supabaseUpsert('sync_metadata', syncRow);
      const newSync = await supabaseGet('sync_metadata',
        '?status=eq.running&order=started_at.desc&limit=1'
      );
      syncId = newSync[0]?.id;
    }

    // ── CALL 1: Locations (skip on resume) ──
    if (mode !== 'resume') {
      await rateLimiter.waitIfNeeded();
      const locResult = await syncLocations();
      log.calls.push(locResult);
    }

    // ── CALL 2: Event Instances (skip on resume) ──
    if (mode !== 'resume') {
      await rateLimiter.waitIfNeeded();
      const eiResult = await syncEventInstances(lastSyncDate);
      log.calls.push(eiResult);
      eventIds = eiResult.event_ids || [];
    }

    // ── CALL 3: Attendance per event ──
    const attResult = await syncAttendance(eventIds, startTime, syncId);
    log.calls.push(attResult);

    // ── Finalize ──
    const finalStatus = attResult.paused ? 'paused' : 'completed';
    if (syncId) {
      await supabasePatch('sync_metadata', `?id=eq.${syncId}`, {
        status: finalStatus,
        finished_at: new Date().toISOString(),
        events_synced: log.calls.find(c => c.endpoint === '/event-instance')?.written || 0,
        attendance_synced: attResult.fetched || 0,
        last_event_id: attResult.last_event_id || 0,
        log: log,
      });
    }

    log.finished_at = new Date().toISOString();
    log.duration_ms = Date.now() - startTime;
    log.status = finalStatus;

    return jsonResponse(log);

  } catch (err) {
    log.errors.push(err.message);
    if (syncId) {
      await supabasePatch('sync_metadata', `?id=eq.${syncId}`, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        errors: log.errors,
        log: log,
      }).catch(() => {});
    }
    console.error('Sync error:', err);
    return errorResponse(err.message);
  }
};


// ── Sync: Locations ─────────────────────────────────────────

async function syncLocations() {
  const t = Date.now();
  const data = await f3ApiGet('/map/location/events-and-locations');

  // F3 Nation API returns either:
  //   (a) an array of positional arrays: [id, name, logo, lat, lon, address, schedule]
  //   (b) an array of objects with named keys
  //   (c) { locations: [...] } wrapper
  const raw = Array.isArray(data) ? data : (data.locations || data.orgs || data.data || []);
  const batch = [];
  for (const loc of raw) {
    let row;
    if (Array.isArray(loc)) {
      // Positional shape — current production response
      const [id, name, logoUrl, lat, lon, address, schedule] = loc;
      if (id == null) continue;
      row = {
        id,
        name: name || 'Unknown',
        lat: lat ?? null,
        lon: lon ?? null,
        address: address || null,
        logo_url: logoUrl || null,
        org_id: null,
        schedule: JSON.stringify(schedule || []),
        synced_at: new Date().toISOString(),
      };
    } else if (loc && loc.id != null) {
      // Object shape — defensive fallback if API changes
      row = {
        id: loc.id,
        name: loc.name || loc.title || 'Unknown',
        lat: loc.lat ?? loc.latitude ?? null,
        lon: loc.lon ?? loc.longitude ?? null,
        address: loc.address || loc.locationDescription || null,
        logo_url: loc.logoUrl || null,
        org_id: loc.orgId ?? null,
        schedule: JSON.stringify(loc.events || loc.schedule || []),
        synced_at: new Date().toISOString(),
      };
    } else {
      continue;
    }
    batch.push(row);
  }

  // Upsert in chunks — 3700+ rows in a single POST occasionally trips Supabase's body limit.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const slice = batch.slice(i, i + CHUNK);
    await supabaseUpsert('f3_locations', slice);
    written += slice.length;
  }

  return {
    endpoint: '/map/location/events-and-locations',
    ms: Date.now() - t,
    locations_written: written,
  };
}


// ── Sync: Event Instances ───────────────────────────────────

async function syncEventInstances(startDate) {
  const t = Date.now();
  let page = 0;
  let allItems = [];

  do {
    await rateLimiter.waitIfNeeded();
    const resp = await f3ApiGet('/event-instance', {
      regionOrgId: F3_REGION_ORG_ID,
      startDate: startDate,
      'statuses[]': 'active',
      pageSize: PAGE_SIZE,
      pageIndex: page,
    });

    // API may return { eventInstances: [...] } or just an array
    const items = resp.eventInstances || (Array.isArray(resp) ? resp : []);
    if (!items.length) break;

    allItems = allItems.concat(items);
    if (items.length < PAGE_SIZE) break;
    page++;
    await sleep(PAUSE_BETWEEN_CALLS_MS);
  } while (page < MAX_PAGES);

  // Pre-insert stub rows for any location_ids referenced by events but missing from
  // /map/location/events-and-locations (F3 Nation data is not perfectly self-consistent).
  const referencedLocIds = Array.from(new Set(
    allItems.map(i => i.locationId).filter(id => id != null)
  ));
  if (referencedLocIds.length > 0) {
    const idList = referencedLocIds.join(',');
    const existing = await supabaseGet('f3_locations', `?select=id&id=in.(${idList})`);
    const existingSet = new Set(existing.map(r => r.id));
    const missing = referencedLocIds.filter(id => !existingSet.has(id));
    if (missing.length > 0) {
      const stubBatch = missing.map(id => ({
        id,
        name: 'Unknown (location ' + id + ')',
        synced_at: new Date().toISOString(),
      }));
      // Chunked upsert for safety
      for (let i = 0; i < stubBatch.length; i += 500) {
        await supabaseUpsert('f3_locations', stubBatch.slice(i, i + 500));
      }
    }
  }

  // Write to Supabase in batches of 100
  let written = 0;
  const eventIds = [];
  for (let i = 0; i < allItems.length; i += 100) {
    const chunk = allItems.slice(i, i + 100);
    const batch = chunk.map(inst => {
      const meta = inst.meta || {};
      if (inst.eventTypes) meta.eventTypes = inst.eventTypes;
      if (inst.eventTags) meta.eventTags = inst.eventTags;

      return {
        id: inst.id,
        name: inst.name || null,
        description: inst.description || null,
        start_date: inst.startDate || null,
        end_date: inst.endDate || null,
        start_time: inst.startTime || null,
        end_time: inst.endTime || null,
        location_id: inst.locationId || null,
        org_id: inst.orgId || null,
        series_id: inst.seriesId || null,
        pax_count: inst.paxCount != null ? inst.paxCount : null,
        fng_count: inst.fngCount != null ? inst.fngCount : null,
        event_type: inst.type || inst.eventType || null,
        event_type_id: inst.eventTypeId || null,
        is_active: inst.isActive !== false,
        backblast: inst.backblast || null,
        meta: JSON.stringify(meta),
        synced_at: new Date().toISOString(),
      };
    });

    await supabaseUpsert('f3_event_instances', batch);
    written += batch.length;
    chunk.forEach(inst => eventIds.push(inst.id));
  }

  return {
    endpoint: '/event-instance',
    ms: Date.now() - t,
    pages: page + 1,
    count: allItems.length,
    written,
    event_ids: eventIds,
  };
}


// ── Sync: Attendance per event ──────────────────────────────

async function syncAttendance(eventIds, startTime, syncId) {
  const t = Date.now();
  let fetched = 0;
  let errors = 0;
  let lastEventId = 0;
  let paused = false;

  for (let i = 0; i < eventIds.length; i++) {
    // Check time limit
    if (Date.now() - startTime > TIME_LIMIT_MS) {
      paused = true;
      lastEventId = eventIds[i > 0 ? i - 1 : 0];
      // Save resume state
      if (syncId) {
        await supabasePatch('sync_metadata', `?id=eq.${syncId}`, {
          status: 'paused',
          last_event_id: lastEventId,
          attendance_synced: fetched,
        }).catch(() => {});
      }
      break;
    }

    const eventId = eventIds[i];
    try {
      await rateLimiter.waitIfNeeded();
      const att = await f3ApiGet(`/attendance/event-instance/${eventId}`, {
        isPlanned: 'false',
      });

      const records = att.attendance || att || [];
      if (Array.isArray(records) && records.length > 0) {
        await processAttendanceRecords(eventId, records);
        fetched++;
      }

      lastEventId = eventId;
    } catch (err) {
      errors++;
      console.error(`Attendance error for event ${eventId}:`, err.message);
    }

    await sleep(PAUSE_BETWEEN_CALLS_MS);
  }

  return {
    endpoint: '/attendance/event-instance/{id}',
    ms: Date.now() - t,
    total: eventIds.length,
    fetched,
    errors,
    paused,
    last_event_id: lastEventId,
  };
}


/**
 * Process attendance records for a single event instance.
 * Upserts users and attendance rows.
 *
 * Response shape (from Waxhaw sync, lines 289-299):
 * {
 *   attendance: [
 *     {
 *       user: { userId: 123, f3Name: "Deflated", avatarUrl: "..." },
 *       attendanceTypes: [{ type: "Q" }]
 *     }
 *   ]
 * }
 */
async function processAttendanceRecords(eventId, records) {
  const users = [];
  const attendance = [];
  const qName = [];
  const coQNames = [];
  const today = new Date().toISOString().split('T')[0];

  for (const rec of records) {
    const user = rec.user || rec;
    const userId = user.userId || user.id;
    const f3Name = user.f3Name || user.f3_name || user.name || 'Unknown';
    const avatarUrl = user.avatarUrl || user.avatar_url || null;

    if (!userId) continue;

    // Determine attendance type
    const types = rec.attendanceTypes || rec.attendance_types || [];
    let attType = 'PAX';
    for (const t of types) {
      const typeName = t.type || t.name || '';
      if (typeName === 'Q') { attType = 'Q'; qName.push(f3Name); }
      if (typeName === 'Co-Q') { attType = 'Co-Q'; coQNames.push(f3Name); }
    }

    users.push({
      id: userId,
      f3_name: f3Name,
      avatar_url: avatarUrl,
      last_seen: today,
      synced_at: new Date().toISOString(),
    });

    attendance.push({
      event_instance_id: eventId,
      user_id: userId,
      attendance_type: attType,
      synced_at: new Date().toISOString(),
    });
  }

  // Batch upsert users
  if (users.length > 0) {
    // For users, we need to handle first_seen specially (only set if not already set)
    // PostgREST merge-duplicates will overwrite, so we set first_seen on insert
    // and rely on it not being overwritten if the column already has a value.
    // We'll set first_seen = last_seen for new users; existing users keep their value
    // because merge-duplicates only updates columns present in the payload.
    // To avoid overwriting first_seen, we do a two-step: upsert without first_seen,
    // then set first_seen where it's null.
    await supabaseUpsert('f3_users', users);

    // Set first_seen for new users (where it's still null)
    await supabasePatch('f3_users',
      '?first_seen=is.null',
      { first_seen: today }
    ).catch(() => {}); // Ignore if no rows match
  }

  // Batch upsert attendance
  if (attendance.length > 0) {
    await supabaseUpsert('f3_attendance', attendance);
  }

  // Update Q/Co-Q names on the event instance
  if (qName.length > 0 || coQNames.length > 0) {
    const patch = {};
    if (qName.length > 0) patch.q_name = qName[0]; // Primary Q
    if (coQNames.length > 0) patch.co_q_names = JSON.stringify(coQNames);
    await supabasePatch('f3_event_instances', `?id=eq.${eventId}`, patch).catch(() => {});
  }
}


function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
