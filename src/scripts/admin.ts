/**
 * Admin console. Talks to /api/admin/*. Auth is either the Cloudflare Access
 * cookie (nothing to do here) or a bearer ADMIN_TOKEN kept in sessionStorage.
 */
import { STATUSES, BOARD_COLUMNS, TRACK_STEPS } from '../../shared/statuses.js';

type Status = keyof typeof STATUSES;
type Req = Record<string, any>;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => Array.from(root.querySelectorAll<T>(sel));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtDay = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const hours = (min: number) => (min ? `${(min / 60).toFixed(1)}h` : '0h');
const grams = (g: number) => `${Math.round(g)} g`;
const money = (n: number) => `$${n.toFixed(2)}`;

let TOKEN = sessionStorage.getItem('hpc_admin_token') || '';
let requests: Req[] = [];
let currentRequestId: number | null = null;
let open: Req | null = null;
let query = '';
let statsCache: any = null;

function toast(msg: string, bad = false) {
  const t = $('[data-toast]');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' is-bad' : '');
  t.hidden = false;
  window.clearTimeout((t as any)._tm);
  (t as any)._tm = window.setTimeout(() => (t.hidden = true), 2800);
}

async function api(path: string, init: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) {
    showAuth('Sign in required.');
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.startsWith('image/')) return res;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
}

/* ---------------- auth ---------------- */
function showAuth(msg = '') {
  $('[data-auth]').hidden = false;
  const err = $('[data-auth-error]');
  err.textContent = msg;
  err.hidden = !msg;
}
$('[data-auth-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const tok = String(new FormData(e.target as HTMLFormElement).get('token') || '').trim();
  if (!tok) return;
  TOKEN = tok;
  sessionStorage.setItem('hpc_admin_token', tok);
  try {
    await boot();
    $('[data-auth]').hidden = true;
  } catch {
    showAuth('That token did not work.');
  }
});

/* ---------------- tabs ---------------- */
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('is-active', x === t));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
    if (t.dataset.tab === 'stats') loadStats();
  }),
);
$('[data-refresh]').addEventListener('click', () => loadRequests().then(() => toast('Refreshed')));
$<HTMLInputElement>('.search').addEventListener('input', (e) => {
  query = (e.target as HTMLInputElement).value.trim().toLowerCase();
  renderAll();
});

/* ---------------- data ---------------- */
async function loadRequests() {
  const d = await api('/api/admin/requests?limit=500');
  requests = d.requests;
  currentRequestId = d.current_request_id;
  renderAll();
  if (open) {
    const fresh = requests.find((r) => r.id === open!.id);
    if (fresh) refreshDrawer(open.id);
  }
}

function filtered() {
  if (!query) return requests;
  return requests.filter((r) => [r.short_id, r.name, r.email, r.title, r.color, r.material, r.admin_notes].join(' ').toLowerCase().includes(query));
}

function cardHtml(r: Req) {
  const isLive = r.id === currentRequestId;
  const due = r.needed_by ? `<span class="due">due ${esc(r.needed_by.slice(5))}</span>` : '';
  const pct = r.status === 'printing' && r.progress != null ? `<div class="card-bar"><div style="width:${r.progress}%"></div></div>` : '';
  return `<button class="card-req${r.priority > 0 ? ' is-priority' : ''}${r.priority < 0 ? ' is-low' : ''}" data-open="${r.id}">
    <div class="card-id"><span>${esc(r.short_id)}</span>${isLive ? '<span class="live">● printer</span>' : `<span>${fmtDay(r.created_at)}</span>`}</div>
    <div class="card-t">${esc(r.title)}</div>
    <div class="card-m">${esc(r.name)} · ${r.quantity}× ${esc(r.color || '')}</div>
    <div class="card-f">${due}${r.grams ? `<span>${grams(r.grams)}</span>` : ''}${r.minutes ? `<span>${hours(r.minutes)}</span>` : ''}${r.eta ? `<span>eta ${esc(r.eta.slice(5))}</span>` : ''}</div>
    ${pct}
  </button>`;
}

function renderBoard() {
  const list = filtered();
  for (const k of BOARD_COLUMNS) {
    const col = $(`[data-col="${k}"]`);
    const rows = list.filter((r) => r.status === k);
    $('[data-count]', col).textContent = String(rows.length);
    $('[data-cards]', col).innerHTML = rows.map(cardHtml).join('');
  }
}

function renderList() {
  const list = filtered();
  $('[data-rows]').innerHTML = list
    .map((r) => {
      const s = STATUSES[r.status as Status];
      return `<tr class="row-req" data-open="${r.id}">
        <td class="mono">${esc(r.short_id)}</td>
        <td>${esc(r.title)}${r.file_url ? ' <a class="mono" href="' + esc(r.file_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>' : ''}</td>
        <td>${esc(r.name)}<br><span class="mono">${esc(r.email)}</span></td>
        <td><span class="pill tone-${s?.tone}">${esc(s?.short || r.status)}</span></td>
        <td>${r.quantity}</td><td>${esc(r.color || '')}</td>
        <td class="mono">${r.grams ? grams(r.grams) : ''}</td><td class="mono">${r.minutes ? hours(r.minutes) : ''}</td>
        <td class="mono">${esc(r.needed_by || '')}</td><td class="mono">${fmtDay(r.created_at)}</td>
      </tr>`;
    })
    .join('');
  $('[data-list-empty]').hidden = list.length > 0;
}

function renderPrinterPill() {
  const pill = $('[data-printer-pill]');
  const cur = requests.find((r) => r.id === currentRequestId);
  pill.classList.toggle('is-live', !!cur);
  $('[data-printer-label]').textContent = cur
    ? `${cur.short_id}${cur.progress != null ? ` · ${Math.round(cur.progress)}%` : ''}`
    : 'Printer idle';
}

function renderAll() {
  renderBoard();
  renderList();
  renderPrinterPill();
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
  if (el) openDrawer(Number(el.dataset.open));
});

/* ---------------- drawer ---------------- */
const drawer = $('[data-drawer]');
const scrim = $('[data-scrim]');
const closeDrawer = () => {
  drawer.hidden = true;
  scrim.hidden = true;
  open = null;
  history.replaceState(null, '', location.pathname);
};
$('[data-close]').addEventListener('click', closeDrawer);
scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !drawer.hidden && closeDrawer());

async function openDrawer(id: number) {
  drawer.hidden = false;
  scrim.hidden = true; // keep the board visible/scrollable behind; drawer is wide enough
  history.replaceState(null, '', `#${id}`);
  await refreshDrawer(id);
  $('.drawer-body').scrollTop = 0;
}

async function refreshDrawer(id: number) {
  const d = await api(`/api/admin/requests/${id}`);
  open = d.request;
  const r = d.request as Req;

  $('[data-d="short_id"]').textContent = r.short_id;
  $('[data-d="created"]').textContent = fmt(r.created_at);
  $('[data-d="title"]').textContent = r.title;
  const mail = $<HTMLAnchorElement>('[data-d="mailto"]');
  mail.textContent = `${r.name} · ${r.email}`;
  mail.href = `mailto:${r.email}?subject=${encodeURIComponent(`${r.short_id} · ${r.title}`)}`;

  // status form
  const sf = $<HTMLFormElement>('[data-status-form]');
  (sf.elements.namedItem('status') as HTMLSelectElement).value = r.status;
  (sf.elements.namedItem('eta') as HTMLInputElement).value = r.eta || '';
  (sf.elements.namedItem('note') as HTMLTextAreaElement).value = '';
  $('[data-status-hint]').textContent = STATUSES[r.status as Status]?.blurb || '';
  const idx = TRACK_STEPS.indexOf(r.status);
  const next = idx >= 0 && idx < TRACK_STEPS.length - 1 ? TRACK_STEPS[idx + 1] : null;
  $('[data-next]').innerHTML = TRACK_STEPS.filter((k) => k !== r.status)
    .map((k) => `<button type="button" class="next-btn${k === next ? ' is-next' : ''}" data-next-status="${k}">${k === next ? '→ ' : ''}${esc(STATUSES[k as Status].short)}</button>`)
    .join('') +
    `<button type="button" class="next-btn" data-next-status="on_hold">Hold</button><button type="button" class="next-btn" data-next-status="declined">Decline</button>`;

  // printer block
  $<HTMLInputElement>('[data-current-toggle]').checked = currentRequestId === r.id;
  $<HTMLInputElement>('[data-share-toggle]').checked = !!r.share_camera;
  const liveRow = $('[data-live-row]');
  if (r.progress_at) {
    liveRow.hidden = false;
    $('[data-live-fill]').style.width = `${r.progress ?? 0}%`;
    const eta = r.progress_eta_seconds != null ? `${Math.floor(r.progress_eta_seconds / 3600)}h ${Math.round((r.progress_eta_seconds % 3600) / 60)}m left` : '';
    $('[data-live-meta]').innerHTML = `<span>${Math.round(r.progress ?? 0)}% · ${esc(r.progress_state || '')}${r.progress_file ? ' · ' + esc(r.progress_file) : ''}</span><span>${esc(eta)} · ${fmt(r.progress_at)}</span>`;
  } else liveRow.hidden = true;
  const snap = $('[data-snap]');
  if (d.snapshots?.length) {
    snap.hidden = false;
    $('[data-snap-stamp]').textContent = fmt(d.snapshots[0].taken_at);
    loadSnapshot(r.id);
  } else snap.hidden = true;
  $('[data-printer-hint]').textContent = currentRequestId === r.id
    ? 'The bridge is posting progress here. Flip status to Printing and (optionally) share the camera.'
    : 'Toggle this on when you start the print so the bridge knows where to send progress.';

  // details form
  const df = $<HTMLFormElement>('[data-details-form]');
  for (const k of ['name', 'email', 'title', 'file_url', 'quantity', 'color', 'material', 'size_notes', 'needed_by', 'priority', 'printer', 'details', 'admin_notes']) {
    const el = df.elements.namedItem(k) as HTMLInputElement | null;
    if (el) el.value = r[k] ?? (k === 'priority' ? '0' : k === 'material' ? 'Any' : '');
  }
  const fl = $<HTMLAnchorElement>('[data-file-link]');
  fl.hidden = !r.file_url;
  fl.href = r.file_url || '#';

  // logs
  const logs = d.logs as Req[];
  $('[data-logs]').innerHTML = logs.length
    ? logs.map((l) => `<tr>
        <td class="mono">${fmtDay(l.logged_at)}</td>
        <td>${grams(l.grams)} · ${hours(l.minutes)}</td>
        <td>${esc(l.material || '')} ${esc(l.color || '')}${l.success ? '' : ' <span class="pill tone-bad">failed</span>'}</td>
        <td>${esc(l.notes || '')}</td>
        <td><button class="log-del" data-del-log="${l.id}" title="Delete">×</button></td>
      </tr>`).join('')
    : '<tr><td class="mono">Nothing logged yet.</td></tr>';
  $('[data-log-total]').textContent = logs.length ? `${grams(r.grams)} · ${hours(r.minutes)}` : '';
  const lf = $<HTMLFormElement>('[data-log-form]');
  const lm = lf.elements.namedItem('material') as HTMLSelectElement;
  if (r.material && r.material !== 'Any') lm.value = r.material;
  (lf.elements.namedItem('color') as HTMLInputElement).value = r.color && !/no preference/i.test(r.color) ? r.color : '';

  // events
  $('[data-events]').innerHTML = (d.events as Req[])
    .map((e) => `<li class="ev${e.public ? '' : ' is-private'}">
      <span class="ev-when">${fmt(e.created_at)}</span>
      <span>${e.status ? `<span class="ev-s">${esc(STATUSES[e.status as Status]?.label || e.status)}</span>` : ''}${e.note ? `${e.status ? ' — ' : ''}${esc(e.note)}` : ''}
        <span class="ev-flags">${e.public ? '' : 'private '}${e.notified ? '✉' : ''}</span></span>
    </li>`)
    .join('');
}

async function loadSnapshot(id: number) {
  try {
    const res = (await api(`/api/admin/requests/${id}/snapshot`)) as Response;
    const blob = await res.blob();
    const img = $<HTMLImageElement>('[data-snap-img]');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
  } catch { /* no snapshot */ }
}

// quick status buttons just pre-select in the form
$('[data-next]').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-next-status]');
  if (!b) return;
  const sf = $<HTMLFormElement>('[data-status-form]');
  (sf.elements.namedItem('status') as HTMLSelectElement).value = b.dataset.nextStatus!;
  $('[data-status-hint]').textContent = STATUSES[b.dataset.nextStatus as Status].blurb;
  (sf.elements.namedItem('note') as HTMLTextAreaElement).focus();
});
$<HTMLFormElement>('[data-status-form]').addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.name === 'status') $('[data-status-hint]').textContent = STATUSES[t.value as Status].blurb;
});

$<HTMLFormElement>('[data-status-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!open) return;
  const fd = new FormData(e.target as HTMLFormElement);
  const payload = {
    status: fd.get('status'),
    eta: fd.get('eta') || null,
    note: fd.get('note'),
    notify: fd.get('notify') === 'on',
    public: fd.get('public') === 'on',
  };
  try {
    const d = await api(`/api/admin/requests/${open.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast(d.email ? (d.email.sent ? 'Updated · email sent' : `Updated · email not sent (${d.email.reason})`) : 'Updated');
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});

$<HTMLFormElement>('[data-details-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!open) return;
  const fd = new FormData(e.target as HTMLFormElement);
  const payload: Record<string, any> = {};
  fd.forEach((v, k) => { if (k !== 'details') payload[k] = v; });
  try {
    await api(`/api/admin/requests/${open.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
    toast('Saved');
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});

$<HTMLInputElement>('[data-current-toggle]').addEventListener('change', async (e) => {
  if (!open) return;
  const on = (e.target as HTMLInputElement).checked;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ current_request_id: on ? open.id : null }) });
    toast(on ? `${open.short_id} is on the printer` : 'Printer cleared');
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});
$<HTMLInputElement>('[data-share-toggle]').addEventListener('change', async (e) => {
  if (!open) return;
  try {
    await api(`/api/admin/requests/${open.id}`, { method: 'PATCH', body: JSON.stringify({ share_camera: (e.target as HTMLInputElement).checked }) });
    toast('Camera sharing updated');
  } catch (err) { toast((err as Error).message, true); }
});

$<HTMLFormElement>('[data-log-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!open) return;
  const f = e.target as HTMLFormElement;
  const fd = new FormData(f);
  const payload = {
    grams: fd.get('grams'), minutes: fd.get('minutes'), material: fd.get('material'), color: fd.get('color'),
    notes: fd.get('notes'), success: fd.get('failed') !== 'on',
  };
  try {
    await api(`/api/admin/requests/${open.id}/logs`, { method: 'POST', body: JSON.stringify(payload) });
    (f.elements.namedItem('grams') as HTMLInputElement).value = '';
    (f.elements.namedItem('minutes') as HTMLInputElement).value = '';
    (f.elements.namedItem('notes') as HTMLInputElement).value = '';
    (f.elements.namedItem('failed') as HTMLInputElement).checked = false;
    toast('Logged');
    statsCache = null;
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});
$('[data-logs]').addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-del-log]');
  if (!b || !open) return;
  try {
    await api(`/api/admin/logs/${b.dataset.delLog}`, { method: 'DELETE' });
    statsCache = null;
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});

$<HTMLFormElement>('[data-msg-form]').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!open) return;
  const f = e.target as HTMLFormElement;
  const fd = new FormData(f);
  try {
    const d = await api(`/api/admin/requests/${open.id}/message`, { method: 'POST', body: JSON.stringify({ subject: fd.get('subject'), body: fd.get('body') }) });
    toast(d.email.sent ? 'Email sent' : `Not sent (${d.email.reason})`, !d.email.sent);
    f.reset();
    await refreshDrawer(open.id);
  } catch (err) { toast((err as Error).message, true); }
});

$('[data-delete]').addEventListener('click', async () => {
  if (!open) return;
  if (!confirm(`Delete ${open.short_id} "${open.title}"? This removes its logs and snapshots too.`)) return;
  try {
    await api(`/api/admin/requests/${open.id}`, { method: 'DELETE' });
    toast('Deleted');
    closeDrawer();
    statsCache = null;
    await loadRequests();
  } catch (err) { toast((err as Error).message, true); }
});

/* ---------------- stats ---------------- */
function bars(el: HTMLElement, rows: { k: string; v: number; label: string }[]) {
  const max = Math.max(1, ...rows.map((r) => r.v));
  el.innerHTML = rows.length
    ? rows.map((r) => `<div class="bar-row"><span class="k">${esc(r.k)}</span><div class="bar"><div style="width:${(r.v / max) * 100}%"></div></div><span class="v">${esc(r.label)}</span></div>`).join('')
    : '<p class="hint">Nothing yet.</p>';
}

function renderWhatIf() {
  if (!statsCache) return;
  const t = statsCache.totals;
  const price = parseFloat($<HTMLInputElement>('[data-spool-price]').value) || 0;
  const rate = parseFloat($<HTMLInputElement>('[data-hourly]').value) || 0;
  const filament = (t.grams / 1000) * price;
  const time = (t.minutes / 60) * rate;
  $('[data-whatif]').innerHTML =
    `${grams(t.grams)} of filament is about <strong>${money(filament)}</strong> at $${price}/kg. ` +
    `${hours(t.minutes)} of printer time at $${rate}/h is <strong>${money(time)}</strong>. ` +
    `So this hobby has "cost" roughly <strong>${money(filament + time)}</strong>, ` +
    `${t.failed ? `including ${grams(t.failed_grams)} on ${t.failed} failed print${t.failed === 1 ? '' : 's'}.` : 'with zero failed prints logged. Suspicious.'}`;
}

async function loadStats() {
  try {
    statsCache = await api('/api/admin/stats');
  } catch (err) { toast((err as Error).message, true); return; }
  const s = statsCache;
  const t = s.totals;
  const active = ['reviewing', 'queued', 'printing', 'finishing'].reduce((n, k) => n + (s.by_status[k] || 0), 0);
  const tiles = [
    ['Open requests', String((s.by_status.received || 0) + active), ''],
    ['Delivered', String(s.by_status.delivered || 0), ''],
    ['Filament used', grams(t.grams), ''],
    ['Printer time', hours(t.minutes), ''],
    ['Est. filament cost', money(t.est_cost), `@ $${t.spool_price_per_kg}/kg`],
    ['Failed prints', String(t.failed), t.jobs ? `${Math.round((1 - t.failed / t.jobs) * 100)}% success` : ''],
  ];
  $('[data-tiles]').innerHTML = tiles.map(([k, v, sub]) => `<div class="tile-stat"><div class="tile-k">${k}</div><div class="tile-v">${v}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`).join('');
  bars($('[data-bars-month]'), s.by_month.map((m: any) => ({ k: m.month, v: m.grams, label: `${grams(m.grams)} · ${hours(m.minutes)}` })));
  bars($('[data-bars-material]'), s.by_material.map((m: any) => ({ k: m.material, v: m.grams, label: `${grams(m.grams)} · ${m.jobs} job${m.jobs === 1 ? '' : 's'}` })));
  bars($('[data-bars-requests]'), s.requests_by_month.map((m: any) => ({ k: m.month, v: m.n, label: `${m.n}` })));
  $('[data-people]').innerHTML = s.top_people.map((p: any) => `<tr><td>${esc(p.name)}<br><span class="mono">${esc(p.email)}</span></td><td class="mono">${p.requests} req</td><td class="mono">${grams(p.grams)}</td><td class="mono">${hours(p.minutes)}</td></tr>`).join('') || '<tr><td class="hint">No one yet.</td></tr>';
  $('[data-recent-logs]').innerHTML = s.recent_logs.map((l: any) => `<tr><td class="mono">${fmtDay(l.logged_at)}</td><td>${esc(l.short_id)} · ${esc(l.title)}</td><td class="mono">${grams(l.grams)} · ${hours(l.minutes)}</td><td>${esc(l.material || '')} ${esc(l.color || '')}${l.success ? '' : ' <span class="pill tone-bad">failed</span>'}</td></tr>`).join('') || '<tr><td class="hint">No logs yet.</td></tr>';
  $<HTMLInputElement>('[data-spool-price]').value = String(t.spool_price_per_kg);
  renderWhatIf();
}
$<HTMLInputElement>('[data-hourly]').addEventListener('input', renderWhatIf);
$<HTMLInputElement>('[data-spool-price]').addEventListener('change', async (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value) || 0;
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ spool_price_per_kg: v }) });
    statsCache.totals.spool_price_per_kg = v;
    statsCache.totals.est_cost = (statsCache.totals.grams / 1000) * v;
    renderWhatIf();
    toast('Spool price saved');
  } catch (err) { toast((err as Error).message, true); }
});

/* ---------------- boot ---------------- */
async function boot() {
  const me = await api('/api/admin/me');
  $('[data-who]').textContent = me.email;
  const settings = await api('/api/admin/settings');
  const warnings: string[] = [];
  if (!settings.email) warnings.push('RESEND_API_KEY not set: emails are logged, not sent.');
  if (!settings.printer_token) warnings.push('PRINTER_TOKEN not set: the printer bridge cannot post progress.');
  const banner = $('[data-banner]');
  banner.textContent = warnings.join('  ·  ');
  banner.hidden = warnings.length === 0;
  await loadRequests();
  const hash = Number(location.hash.slice(1));
  if (hash) openDrawer(hash);
  // Light polling so the board follows the printer without a refresh.
  window.setInterval(() => loadRequests().catch(() => {}), 60_000);
}

boot().catch((err) => {
  if ((err as Error).message !== 'unauthorized') showAuth((err as Error).message);
});
