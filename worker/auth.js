/**
 * Admin + printer auth.
 *
 * Admin (the CMS at /admin and /api/admin/*), two accepted credentials:
 *   1. Cloudflare Access — put an Access application in front of /admin* and
 *      /api/admin* (same as HQ). Access injects a signed JWT on every request;
 *      we verify it against your team's public keys. Needs vars:
 *        ACCESS_TEAM_DOMAIN  e.g. "harborpointe.cloudflareaccess.com"
 *        ACCESS_AUD          the application's Audience tag (secret)
 *   2. ADMIN_TOKEN (secret) — `Authorization: Bearer <token>`. Used by the
 *      admin page in local dev (no Access there), or as a break-glass.
 *
 * Printer bridge (/api/printer/*): PRINTER_TOKEN (secret) as a bearer token.
 */
import { HttpError, safeEqual } from './util.js';

let certCache = { keys: null, fetchedAt: 0 };

function b64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}
const b64urlBytes = (s) => Uint8Array.from(b64url(s), (c) => c.charCodeAt(0));

async function accessKeys(teamDomain) {
  const fresh = Date.now() - certCache.fetchedAt < 60 * 60 * 1000;
  if (certCache.keys && fresh) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs ${res.status}`);
  const body = await res.json();
  certCache = { keys: body.keys || [], fetchedAt: Date.now() };
  return certCache.keys;
}

/** Verify a Cloudflare Access JWT. Returns { email } or null. */
export async function verifyAccessJwt(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return null;

  let token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    if (m) token = m[1];
  }
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64url(parts[0]));
    payload = JSON.parse(b64url(parts[1]));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256') return null;

  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk || !payload.exp || payload.exp < now) return null;
  if (payload.iss !== `https://${team}`) return null;

  const keys = await accessKeys(team);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  return ok ? { email: payload.email || 'access-user', via: 'access' } : null;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Throws 401 unless the request is an authenticated admin. */
export async function requireAdmin(request, env) {
  const viaAccess = await verifyAccessJwt(request, env);
  if (viaAccess) return viaAccess;
  const tok = bearer(request);
  if (env.ADMIN_TOKEN && tok && safeEqual(tok, env.ADMIN_TOKEN)) {
    return { email: 'admin-token', via: 'token' };
  }
  if (!env.ADMIN_TOKEN && !(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD)) {
    throw new HttpError(503, 'Admin is not configured. Set ADMIN_TOKEN or Cloudflare Access.');
  }
  throw new HttpError(401, 'Sign in required.');
}

export function requirePrinter(request, env) {
  const tok = bearer(request);
  if (!env.PRINTER_TOKEN) throw new HttpError(503, 'PRINTER_TOKEN is not set.');
  if (!tok || !safeEqual(tok, env.PRINTER_TOKEN)) throw new HttpError(401, 'Bad printer token.');
  return true;
}

export const accessConfigured = (env) => !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
