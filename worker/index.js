/**
 * Cloudflare Worker — Harbor Pointe Creates.
 *
 * Static Astro build in ./dist is served via the ASSETS binding. This Worker
 * runs first on every request (wrangler.jsonc: run_worker_first) so it can:
 *
 *   POST /api/requests                      public: submit a request
 *   GET  /api/track/:token                  public: status + timeline + progress
 *   GET  /api/track/:token/snapshot         public: latest webcam frame (if shared)
 *
 *   GET  /admin                             gated page (Cloudflare Access / token)
 *   GET  /api/admin/me
 *   GET  /api/admin/requests?status=&q=
 *   GET  /api/admin/requests/:id
 *   PATCH/DELETE /api/admin/requests/:id
 *   POST /api/admin/requests/:id/message    freeform email to the requester
 *   POST /api/admin/requests/:id/logs       filament + time entry
 *   DELETE /api/admin/logs/:id
 *   GET  /api/admin/requests/:id/snapshot
 *   GET  /api/admin/stats
 *   GET/PUT /api/admin/settings             current printer job, spool price
 *
 *   GET  /api/printer/current               bridge: which request is on the bed
 *   POST /api/printer/progress              bridge: progress + optional snapshot
 *
 * Bindings / vars: see wrangler.jsonc. Secrets: RESEND_API_KEY, ADMIN_TOKEN,
 * PRINTER_TOKEN, ACCESS_AUD.
 */
import { STATUSES, isStatus, MATERIALS } from '../shared/statuses.js';
import { json, HttpError, emailRe, str, randomToken, sha256Hex, shortIdFor, b64ToBytes, nowIso } from './util.js';
import { requireAdmin, requirePrinter, verifyAccessJwt, accessConfigured } from './auth.js';
import { sendEmail, confirmationEmail, ownerNewRequestEmail, statusEmail, messageEmail } from './email.js';

const MAX_SNAPSHOTS_PER_REQUEST = 10;
const MAX_SNAPSHOT_BYTES = 700 * 1024;

/* ----------------------------------------------------------------------------
 * DB helpers
 * ------------------------------------------------------------------------- */
const getRequest = async (db, id) =>
  db.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();

const getRequestByToken = async (db, token) =>
  db.prepare('SELECT * FROM requests WHERE token = ?').bind(token).first();

async function addEvent(db, requestId, { status = null, note = null, isPublic = 1, notified = 0 }) {
  await db
    .prepare('INSERT INTO events (request_id, status, note, public, notified) VALUES (?, ?, ?, ?, ?)')
    .bind(requestId, status, note, isPublic ? 1 : 0, notified ? 1 : 0)
    .run();
}

const touch = (db, id) =>
  db.prepare("UPDATE requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").bind(id).run();

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}
const setSetting = (db, key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value === null || value === undefined ? null : String(value))
    .run();

/** Strip private fields for the public tracking view. */
function publicView(r, events, snapshot) {
  const liveish = r.status === 'printing' && r.progress_at;
  return {
    short_id: r.short_id,
    title: r.title,
    quantity: r.quantity,
    color: r.color,
    material: r.material,
    status: r.status,
    status_label: STATUSES[r.status]?.label,
    eta: r.eta,
    created_at: r.created_at,
    updated_at: r.updated_at,
    events: events.map((e) => ({ at: e.created_at, status: e.status, note: e.note })),
    progress: liveish
      ? {
          percent: r.progress,
          state: r.progress_state,
          eta_seconds: r.progress_eta_seconds,
          at: r.progress_at,
        }
      : null,
    snapshot: liveish && r.share_camera && snapshot ? { at: snapshot.taken_at } : null,
  };
}

/* ----------------------------------------------------------------------------
 * Public: submit
 * ------------------------------------------------------------------------- */
async function handleSubmit(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin) {
    let host;
    try { host = new URL(origin).hostname; } catch { throw new HttpError(403, 'Forbidden.'); }
    if (host !== url.hostname) throw new HttpError(403, 'Forbidden.');
  }

  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid request body.'); }

  // Honeypot: hidden "website" field. Bots fill it; pretend success.
  if (str(body.website)) return json({ ok: true, short_id: 'HPC-0000', token: 'x' });

  const r = {
    name: str(body.name, 120),
    email: str(body.email, 200),
    title: str(body.title, 200),
    file_url: str(body.file_url, 1000),
    details: str(body.details, 4000),
    quantity: Math.min(50, Math.max(1, parseInt(body.quantity, 10) || 1)),
    color: str(body.color, 60),
    material: str(body.material, 30),
    size_notes: str(body.size_notes, 300),
    needed_by: str(body.needed_by, 20),
  };
  if (!r.name || !emailRe.test(r.email) || !r.title) {
    throw new HttpError(422, 'Name, a valid email, and what you want are required.');
  }
  if (r.file_url && !/^https?:\/\//i.test(r.file_url)) throw new HttpError(422, 'The file link must start with http:// or https://');
  if (r.needed_by && !/^\d{4}-\d{2}-\d{2}$/.test(r.needed_by)) r.needed_by = '';
  if (r.material && !MATERIALS.includes(r.material)) r.material = 'Any';

  // Light rate limit: 6 submissions per IP per hour.
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const ipHash = (await sha256Hex(`${ip}|hpc`)).slice(0, 32);
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE ip_hash = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')")
    .bind(ipHash)
    .first();
  if (recent && recent.n >= 6) throw new HttpError(429, 'That is a lot of requests at once. Give it an hour, or email me.');

  const token = randomToken(16);
  const ins = await env.DB
    .prepare(
      `INSERT INTO requests (short_id, token, name, email, title, file_url, details, quantity, color, material, size_notes, needed_by, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(`pending-${token}`, token, r.name, r.email, r.title, r.file_url || null, r.details || null, r.quantity, r.color || null, r.material || null, r.size_notes || null, r.needed_by || null, ipHash)
    .run();
  const id = ins.meta.last_row_id;
  const shortId = shortIdFor(id);
  await env.DB.prepare('UPDATE requests SET short_id = ? WHERE id = ?').bind(shortId, id).run();
  await addEvent(env.DB, id, { status: 'received', note: null, isPublic: 1, notified: 1 });

  const row = { ...r, id, short_id: shortId, token };
  const site = url.origin;
  const results = await Promise.allSettled([
    sendEmail(env, confirmationEmail(env, site, row)),
    env.CONTACT_TO ? sendEmail(env, ownerNewRequestEmail(env, site, row)) : Promise.resolve({ sent: false }),
  ]);
  results.forEach((x) => x.status === 'rejected' && console.error('email failed', x.reason));

  return json({ ok: true, short_id: shortId, token }, 201);
}

/* ----------------------------------------------------------------------------
 * Public: tracking
 * ------------------------------------------------------------------------- */
async function handleTrack(env, token) {
  const r = await getRequestByToken(env.DB, token);
  if (!r) throw new HttpError(404, 'No request with that link.');
  const events = (await env.DB
    .prepare('SELECT created_at, status, note FROM events WHERE request_id = ? AND public = 1 ORDER BY created_at ASC, id ASC')
    .bind(r.id)
    .all()).results;
  const snap = r.share_camera
    ? await env.DB.prepare('SELECT taken_at FROM snapshots WHERE request_id = ? ORDER BY taken_at DESC LIMIT 1').bind(r.id).first()
    : null;
  return json(publicView(r, events, snap));
}

async function latestSnapshotResponse(env, requestId) {
  const s = await env.DB
    .prepare('SELECT content_type, data, taken_at FROM snapshots WHERE request_id = ? ORDER BY taken_at DESC LIMIT 1')
    .bind(requestId)
    .first();
  if (!s) throw new HttpError(404, 'No snapshot yet.');
  // D1 returns BLOBs as an ArrayBuffer remotely but a plain number[] in some
  // local builds; normalise so Response never stringifies it.
  const bytes = s.data instanceof ArrayBuffer ? s.data : Uint8Array.from(s.data);
  return new Response(bytes, {
    headers: { 'Content-Type': s.content_type || 'image/jpeg', 'Cache-Control': 'no-store', 'X-Taken-At': s.taken_at },
  });
}

async function handleTrackSnapshot(env, token) {
  const r = await getRequestByToken(env.DB, token);
  if (!r || !r.share_camera) throw new HttpError(404, 'No snapshot.');
  return latestSnapshotResponse(env, r.id);
}

/* ----------------------------------------------------------------------------
 * Admin
 * ------------------------------------------------------------------------- */
const LOG_AGG = `
  (SELECT COALESCE(SUM(grams),0) FROM print_logs l WHERE l.request_id = r.id) AS grams,
  (SELECT COALESCE(SUM(minutes),0) FROM print_logs l WHERE l.request_id = r.id) AS minutes,
  (SELECT COUNT(*) FROM print_logs l WHERE l.request_id = r.id) AS log_count`;

async function adminList(env, url) {
  const status = url.searchParams.get('status');
  const q = str(url.searchParams.get('q'), 100);
  const limit = Math.min(500, parseInt(url.searchParams.get('limit'), 10) || 200);
  const where = [];
  const binds = [];
  if (status && isStatus(status)) { where.push('r.status = ?'); binds.push(status); }
  if (q) {
    where.push('(r.name LIKE ? OR r.email LIKE ? OR r.title LIKE ? OR r.short_id LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  const sql = `SELECT r.*, ${LOG_AGG} FROM requests r ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY r.priority DESC, r.created_at DESC LIMIT ?`;
  binds.push(limit);
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results;
  const current = await getSetting(env.DB, 'current_request_id');
  return json({ requests: rows, current_request_id: current ? Number(current) : null });
}

async function adminGet(env, id) {
  const r = await env.DB.prepare(`SELECT r.*, ${LOG_AGG} FROM requests r WHERE r.id = ?`).bind(id).first();
  if (!r) throw new HttpError(404, 'Not found.');
  const [events, logs, snaps] = await Promise.all([
    env.DB.prepare('SELECT * FROM events WHERE request_id = ? ORDER BY created_at DESC, id DESC').bind(id).all(),
    env.DB.prepare('SELECT * FROM print_logs WHERE request_id = ? ORDER BY logged_at DESC').bind(id).all(),
    env.DB.prepare('SELECT id, taken_at, content_type, length(data) AS bytes FROM snapshots WHERE request_id = ? ORDER BY taken_at DESC').bind(id).all(),
  ]);
  return json({ request: r, events: events.results, logs: logs.results, snapshots: snaps.results });
}

const EDITABLE = ['title', 'file_url', 'details', 'quantity', 'color', 'material', 'size_notes', 'needed_by', 'eta', 'printer', 'admin_notes', 'priority', 'share_camera', 'name', 'email'];

async function adminPatch(request, env, url, id) {
  const r = await getRequest(env.DB, id);
  if (!r) throw new HttpError(404, 'Not found.');
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid body.'); }

  const sets = [];
  const binds = [];
  for (const k of EDITABLE) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === 'quantity') v = Math.min(50, Math.max(1, parseInt(v, 10) || 1));
    else if (k === 'priority') v = Math.max(-1, Math.min(1, parseInt(v, 10) || 0));
    else if (k === 'share_camera') v = v ? 1 : 0;
    else if (k === 'email') { v = str(v, 200); if (!emailRe.test(v)) throw new HttpError(422, 'Bad email.'); }
    else { v = str(v, k === 'details' || k === 'admin_notes' ? 8000 : 1000) || null; }
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (sets.length) {
    await env.DB.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  }

  let emailResult = null;
  const newStatus = body.status;
  const note = str(body.note, 2000) || null;
  const isPublic = body.public === undefined ? true : !!body.public;
  const notify = !!body.notify;

  if (newStatus !== undefined && newStatus !== null && newStatus !== '') {
    if (!isStatus(newStatus)) throw new HttpError(422, 'Unknown status.');
    const changed = newStatus !== r.status;
    if (changed) {
      await env.DB.prepare('UPDATE requests SET status = ? WHERE id = ?').bind(newStatus, id).run();
      // Leaving the printer clears live progress and the "current job" pointer.
      if (r.status === 'printing' && newStatus !== 'printing') {
        const cur = await getSetting(env.DB, 'current_request_id');
        if (cur && Number(cur) === id) await setSetting(env.DB, 'current_request_id', null);
      }
    }
    if (changed || note) {
      const fresh = await getRequest(env.DB, id);
      let notified = 0;
      if (notify) {
        emailResult = await sendEmail(env, statusEmail(env, url.origin, fresh, newStatus, note));
        notified = emailResult.sent ? 1 : 0;
      }
      await addEvent(env.DB, id, { status: changed ? newStatus : null, note, isPublic, notified });
    }
  } else if (note) {
    let notified = 0;
    if (notify) {
      emailResult = await sendEmail(env, messageEmail(env, url.origin, r, 'An update on your print', note));
      notified = emailResult.sent ? 1 : 0;
    }
    await addEvent(env.DB, id, { status: null, note, isPublic, notified });
  }

  await touch(env.DB, id);
  return adminGet(env, id).then(async (res) => {
    const data = await res.json();
    return json({ ...data, email: emailResult });
  });
}

async function adminMessage(request, env, url, id) {
  const r = await getRequest(env.DB, id);
  if (!r) throw new HttpError(404, 'Not found.');
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid body.'); }
  const subject = str(body.subject, 150) || 'An update on your print';
  const text = str(body.body, 4000);
  if (!text) throw new HttpError(422, 'Message body is required.');
  const result = await sendEmail(env, messageEmail(env, url.origin, r, subject, text));
  await addEvent(env.DB, id, { status: null, note: `✉ ${subject}: ${text}`, isPublic: 1, notified: result.sent ? 1 : 0 });
  await touch(env.DB, id);
  return json({ ok: true, email: result });
}

async function adminDelete(env, id) {
  const r = await getRequest(env.DB, id);
  if (!r) throw new HttpError(404, 'Not found.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM snapshots WHERE request_id = ?').bind(id),
    env.DB.prepare('DELETE FROM print_logs WHERE request_id = ?').bind(id),
    env.DB.prepare('DELETE FROM events WHERE request_id = ?').bind(id),
    env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(id),
  ]);
  const cur = await getSetting(env.DB, 'current_request_id');
  if (cur && Number(cur) === id) await setSetting(env.DB, 'current_request_id', null);
  return json({ ok: true });
}

async function adminAddLog(request, env, id) {
  const r = await getRequest(env.DB, id);
  if (!r) throw new HttpError(404, 'Not found.');
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid body.'); }
  const grams = Math.max(0, parseFloat(body.grams) || 0);
  const minutes = Math.max(0, parseInt(body.minutes, 10) || 0);
  await env.DB
    .prepare('INSERT INTO print_logs (request_id, printer, material, color, grams, minutes, success, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, str(body.printer, 80) || r.printer || null, str(body.material, 30) || null, str(body.color, 60) || null, grams, minutes, body.success === false || body.success === 0 ? 0 : 1, str(body.notes, 1000) || null)
    .run();
  await touch(env.DB, id);
  return adminGet(env, id);
}

async function adminDeleteLog(env, logId) {
  const row = await env.DB.prepare('SELECT request_id FROM print_logs WHERE id = ?').bind(logId).first();
  if (!row) throw new HttpError(404, 'Not found.');
  await env.DB.prepare('DELETE FROM print_logs WHERE id = ?').bind(logId).run();
  return adminGet(env, row.request_id);
}

async function adminStats(env) {
  const db = env.DB;
  const [byStatus, totals, byMaterial, byMonth, topPeople, recentLogs] = await Promise.all([
    db.prepare('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all(),
    db.prepare(`SELECT COUNT(*) AS jobs, COALESCE(SUM(grams),0) AS grams, COALESCE(SUM(minutes),0) AS minutes,
                COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END),0) AS failed,
                COALESCE(SUM(CASE WHEN success = 0 THEN grams ELSE 0 END),0) AS failed_grams
                FROM print_logs`).first(),
    db.prepare(`SELECT COALESCE(material,'?') AS material, COALESCE(SUM(grams),0) AS grams, COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS jobs
                FROM print_logs GROUP BY material ORDER BY grams DESC`).all(),
    db.prepare(`SELECT substr(logged_at,1,7) AS month, COALESCE(SUM(grams),0) AS grams, COALESCE(SUM(minutes),0) AS minutes, COUNT(*) AS jobs
                FROM print_logs GROUP BY month ORDER BY month DESC LIMIT 12`).all(),
    db.prepare(`SELECT r.name, r.email, COUNT(DISTINCT r.id) AS requests, COALESCE(SUM(l.grams),0) AS grams, COALESCE(SUM(l.minutes),0) AS minutes
                FROM requests r LEFT JOIN print_logs l ON l.request_id = r.id
                GROUP BY r.email ORDER BY grams DESC, requests DESC LIMIT 8`).all(),
    db.prepare(`SELECT l.*, r.short_id, r.title FROM print_logs l JOIN requests r ON r.id = l.request_id ORDER BY l.logged_at DESC LIMIT 10`).all(),
  ]);
  const requestsByMonth = (await db
    .prepare(`SELECT substr(created_at,1,7) AS month, COUNT(*) AS n FROM requests GROUP BY month ORDER BY month DESC LIMIT 12`)
    .all()).results;
  const spool = parseFloat((await getSetting(db, 'spool_price_per_kg')) ?? env.SPOOL_PRICE_PER_KG ?? '22') || 22;
  return json({
    by_status: Object.fromEntries(byStatus.results.map((x) => [x.status, x.n])),
    totals: { ...totals, spool_price_per_kg: spool, est_cost: (totals.grams / 1000) * spool },
    by_material: byMaterial.results,
    by_month: byMonth.results.reverse(),
    requests_by_month: requestsByMonth.reverse(),
    top_people: topPeople.results,
    recent_logs: recentLogs.results,
  });
}

async function adminSettings(request, env) {
  if (request.method === 'PUT') {
    let body;
    try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid body.'); }
    if ('current_request_id' in body) {
      const v = body.current_request_id;
      if (v !== null && v !== '' && !(await getRequest(env.DB, Number(v)))) throw new HttpError(404, 'No such request.');
      await setSetting(env.DB, 'current_request_id', v === '' ? null : v);
    }
    if ('spool_price_per_kg' in body) {
      await setSetting(env.DB, 'spool_price_per_kg', Math.max(0, parseFloat(body.spool_price_per_kg) || 0));
    }
  }
  const cur = await getSetting(env.DB, 'current_request_id');
  const spool = await getSetting(env.DB, 'spool_price_per_kg');
  return json({
    current_request_id: cur ? Number(cur) : null,
    spool_price_per_kg: parseFloat(spool ?? env.SPOOL_PRICE_PER_KG ?? '22') || 22,
    access: accessConfigured(env),
    email: !!env.RESEND_API_KEY,
    printer_token: !!env.PRINTER_TOKEN,
  });
}

/* ----------------------------------------------------------------------------
 * Printer bridge
 * ------------------------------------------------------------------------- */
async function printerCurrent(env) {
  const cur = await getSetting(env.DB, 'current_request_id');
  if (!cur) return json({ request: null });
  const r = await getRequest(env.DB, Number(cur));
  if (!r) return json({ request: null });
  return json({ request: { id: r.id, short_id: r.short_id, title: r.title, status: r.status, share_camera: !!r.share_camera } });
}

async function printerProgress(request, env) {
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Invalid body.'); }

  let id = body.request_id ? Number(body.request_id) : null;
  if (!id && body.short_id) {
    const r = await env.DB.prepare('SELECT id FROM requests WHERE short_id = ?').bind(str(body.short_id, 20)).first();
    id = r?.id ?? null;
  }
  if (!id) {
    const cur = await getSetting(env.DB, 'current_request_id');
    id = cur ? Number(cur) : null;
  }
  if (!id) return json({ ok: true, attached: false, reason: 'No current request. Set one in admin.' });
  const r = await getRequest(env.DB, id);
  if (!r) throw new HttpError(404, 'Request not found.');

  const state = str(body.state, 20) || 'printing';
  const percent = body.percent === undefined || body.percent === null ? null : Math.max(0, Math.min(100, parseFloat(body.percent) || 0));
  const eta = body.eta_seconds === undefined || body.eta_seconds === null ? null : Math.max(0, parseInt(body.eta_seconds, 10) || 0);
  const file = str(body.file, 200) || null;

  await env.DB
    .prepare(`UPDATE requests SET progress = ?, progress_state = ?, progress_file = ?, progress_eta_seconds = ?, progress_at = ? WHERE id = ?`)
    .bind(percent, state, file, eta, nowIso(), id)
    .run();

  // Record printer state transitions as private timeline notes.
  if (state !== r.progress_state && ['complete', 'error', 'paused', 'cancelled'].includes(state)) {
    await addEvent(env.DB, id, { status: null, note: `Printer reported: ${state}${file ? ` (${file})` : ''}`, isPublic: 0, notified: 0 });
  }

  let stored = false;
  if (body.snapshot_b64) {
    const bytes = b64ToBytes(String(body.snapshot_b64));
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new HttpError(413, `Snapshot over ${MAX_SNAPSHOT_BYTES} bytes; downscale it in the bridge.`);
    await env.DB
      .prepare('INSERT INTO snapshots (request_id, content_type, data) VALUES (?, ?, ?)')
      .bind(id, str(body.content_type, 40) || 'image/jpeg', bytes.buffer) // D1 BLOB wants an ArrayBuffer
      .run();
    await env.DB
      .prepare(`DELETE FROM snapshots WHERE request_id = ? AND id NOT IN (SELECT id FROM snapshots WHERE request_id = ? ORDER BY taken_at DESC, id DESC LIMIT ?)`)
      .bind(id, id, MAX_SNAPSHOTS_PER_REQUEST)
      .run();
    stored = true;
  }
  return json({ ok: true, attached: true, request_id: id, short_id: r.short_id, snapshot_stored: stored });
}

/* ----------------------------------------------------------------------------
 * Router
 * ------------------------------------------------------------------------- */
async function route(request, env, url) {
  const { pathname } = url;
  const m = (re) => pathname.match(re);
  const method = request.method;
  let x;

  // ---- public API
  if (pathname === '/api/requests') {
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
    return handleSubmit(request, env, url);
  }
  if ((x = m(/^\/api\/track\/([a-z0-9]+)\/snapshot$/))) return handleTrackSnapshot(env, x[1]);
  if ((x = m(/^\/api\/track\/([a-z0-9]+)$/))) return handleTrack(env, x[1]);

  // ---- printer bridge
  if (pathname.startsWith('/api/printer/')) {
    requirePrinter(request, env);
    if (pathname === '/api/printer/current' && method === 'GET') return printerCurrent(env);
    if (pathname === '/api/printer/progress' && method === 'POST') return printerProgress(request, env);
    throw new HttpError(404, 'Not found.');
  }

  // ---- admin API
  if (pathname.startsWith('/api/admin/')) {
    const who = await requireAdmin(request, env);
    if (pathname === '/api/admin/me') return json({ ...who, statuses: STATUSES });
    if (pathname === '/api/admin/stats') return adminStats(env);
    if (pathname === '/api/admin/settings') return adminSettings(request, env);
    if (pathname === '/api/admin/requests' && method === 'GET') return adminList(env, url);
    if ((x = m(/^\/api\/admin\/requests\/(\d+)$/))) {
      const id = Number(x[1]);
      if (method === 'GET') return adminGet(env, id);
      if (method === 'PATCH') return adminPatch(request, env, url, id);
      if (method === 'DELETE') return adminDelete(env, id);
    }
    if ((x = m(/^\/api\/admin\/requests\/(\d+)\/message$/)) && method === 'POST') return adminMessage(request, env, url, Number(x[1]));
    if ((x = m(/^\/api\/admin\/requests\/(\d+)\/logs$/)) && method === 'POST') return adminAddLog(request, env, Number(x[1]));
    if ((x = m(/^\/api\/admin\/requests\/(\d+)\/snapshot$/)) && method === 'GET') return latestSnapshotResponse(env, Number(x[1]));
    if ((x = m(/^\/api\/admin\/logs\/(\d+)$/)) && method === 'DELETE') return adminDeleteLog(env, Number(x[1]));
    throw new HttpError(404, 'Not found.');
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');

  // ---- admin page: when Access is configured, require it for the HTML too.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (accessConfigured(env)) {
      const ok = await verifyAccessJwt(request, env);
      if (!ok) return new Response('Sign in through Cloudflare Access to open the admin.', { status: 401 });
    } else if (!env.ADMIN_TOKEN) {
      return new Response('Admin is not configured. Set ADMIN_TOKEN (or Cloudflare Access) and redeploy.', { status: 503 });
    }
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('Cache-Control', 'no-store');
    h.set('X-Robots-Tag', 'noindex');
    return new Response(res.body, { status: res.status, headers: h });
  }

  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('unhandled', err);
      return json({ error: 'Something went wrong on my end.' }, 500);
    }
  },
};
