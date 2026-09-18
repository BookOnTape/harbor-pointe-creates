/**
 * Outbound mail via Resend. When RESEND_API_KEY is missing (local dev), the
 * message is logged and reported as not sent — nothing else fails.
 */
import { STATUSES } from '../shared/statuses.js';
import { escapeHtml } from './util.js';

const shell = (env, title, bodyHtml) => `<!doctype html>
<html><body style="margin:0;background:#eef0ea;font-family:Archivo,system-ui,-apple-system,Segoe UI,sans-serif;color:#0b1a21">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="font-family:Georgia,serif;font-size:20px;letter-spacing:-0.02em;margin-bottom:24px">
      Harbor Pointe <em>Creates</em><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#7fcdb8;margin-left:4px"></span>
    </div>
    <div style="background:#ffffff;border-radius:10px;padding:28px 28px 24px;box-shadow:0 1px 2px rgba(11,26,33,.08)">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;letter-spacing:-0.02em;margin:0 0 14px">${title}</h1>
      ${bodyHtml}
    </div>
    <p style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#5b6e73;margin-top:24px">
      ${escapeHtml(env.SITE_NAME || 'Harbor Pointe Creates')} · friends &amp; family printing
    </p>
  </div>
</body></html>`;

const btn = (href, label) =>
  `<p style="margin:22px 0 4px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#ff7a45;color:#0b1a21;font-weight:600;text-decoration:none;padding:12px 20px;border-radius:99px">${escapeHtml(label)}</a></p>`;

const p = (s) => `<p style="line-height:1.6;margin:0 0 12px;color:#0b1a21">${s}</p>`;
const muted = (s) => `<p style="line-height:1.6;margin:0 0 12px;color:#5b6e73;font-size:14px">${s}</p>`;

export async function sendEmail(env, { to, subject, html, text, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:skipped] to=${to} subject=${subject}\n${text}`);
    return { sent: false, reason: 'RESEND_API_KEY not set' };
  }
  const from = env.CONTACT_FROM || 'Harbor Pointe Creates <noreply@harborpointedesigns.com>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('Resend error', res.status, detail);
    return { sent: false, reason: `resend ${res.status}` };
  }
  return { sent: true };
}

export const trackUrl = (origin, token) => `${origin}/track?t=${encodeURIComponent(token)}`;

/** Requester: "we got it" + tracking link. */
export function confirmationEmail(env, origin, r) {
  const url = trackUrl(origin, r.token);
  const owner = env.OWNER_NAME || 'Jer';
  const title = `Request ${r.short_id} is in.`;
  const html = shell(
    env,
    escapeHtml(title),
    p(`Hi ${escapeHtml(r.name)}, got your request for <strong>${escapeHtml(r.title)}</strong>. I’ll look it over and you’ll get an email as it moves along.`) +
      muted(`${escapeHtml(String(r.quantity))}× · ${escapeHtml(r.color || 'any color')} · ${escapeHtml(r.material || 'any material')}${r.needed_by ? ' · needed by ' + escapeHtml(r.needed_by) : ''}`) +
      (r.file_url ? '' : muted('No file link yet? Reply to this email with the STL / 3MF attached and I’ll add it to the request.')) +
      btn(url, 'Track this request') +
      muted(`Keep this link — it’s the only way to see the status. — ${escapeHtml(owner)}`),
  );
  const text = `Hi ${r.name}, got your request for "${r.title}" (${r.short_id}).\n\nTrack it here: ${url}\n\n${r.file_url ? '' : 'No file link yet? Reply to this email with the file attached.\n\n'}— ${owner}`;
  return { to: r.email, subject: `${r.short_id} · got your request for ${r.title}`, html, text };
}

/** Owner: new request landed. */
export function ownerNewRequestEmail(env, origin, r) {
  const admin = `${origin}/admin#${r.id}`;
  const rows = [
    ['From', `${r.name} <${r.email}>`],
    ['What', r.title],
    ['File', r.file_url || '—'],
    ['Qty / color / material', `${r.quantity} / ${r.color || '—'} / ${r.material || '—'}`],
    ['Size', r.size_notes || '—'],
    ['Needed by', r.needed_by || '—'],
    ['Notes', r.details || '—'],
  ];
  const html = shell(
    env,
    `New request · ${escapeHtml(r.short_id)}`,
    rows
      .map(([k, v]) => `<p style="margin:0 0 8px"><span style="font-family:ui-monospace,Menlo,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#5b6e73">${k}</span><br>${escapeHtml(v)}</p>`)
      .join('') + btn(admin, 'Open in admin'),
  );
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\n${admin}`;
  return { to: env.CONTACT_TO, subject: `New print request ${r.short_id}: ${r.title}`, html, text, replyTo: r.email };
}

/** Requester: status moved. */
export function statusEmail(env, origin, r, status, note) {
  const s = STATUSES[status];
  const url = trackUrl(origin, r.token);
  const owner = env.OWNER_NAME || 'Jer';
  const html = shell(
    env,
    `${escapeHtml(r.short_id)} · ${escapeHtml(s.label)}`,
    p(`<strong>${escapeHtml(r.title)}</strong> — ${escapeHtml(s.blurb)}`) +
      (note ? p(`<em>“${escapeHtml(note)}”</em>`) : '') +
      (r.eta && !s.terminal ? muted(`Estimated ready: ${escapeHtml(r.eta)}`) : '') +
      btn(url, status === 'printing' ? 'Watch it print' : 'See the status') +
      muted(`— ${escapeHtml(owner)}`),
  );
  const text = `${r.short_id} · ${s.label}\n\n${r.title} — ${s.blurb}${note ? `\n\n"${note}"` : ''}\n\n${url}\n\n— ${owner}`;
  return { to: r.email, subject: `${r.short_id} · ${s.label}: ${r.title}`, html, text };
}

/** Requester: freeform note from the owner. */
export function messageEmail(env, origin, r, subject, body) {
  const url = trackUrl(origin, r.token);
  const owner = env.OWNER_NAME || 'Jer';
  const html = shell(
    env,
    escapeHtml(subject),
    p(escapeHtml(body).replace(/\n/g, '<br>')) + btn(url, 'See the request') + muted(`— ${escapeHtml(owner)}`),
  );
  return { to: r.email, subject: `${r.short_id} · ${subject}`, html, text: `${body}\n\n${url}\n\n— ${owner}` };
}
