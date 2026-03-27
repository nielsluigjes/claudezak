export const config = { runtime: 'edge' };

const COOKIE_NAME = 'czs';
const SESSION_TTL_SECONDS = Number(process.env.CZ_SESSION_TTL_SECONDS || 60 * 60); // 1h

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function getClientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function base64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return b64;
}

function utf8(str) {
  return new TextEncoder().encode(str);
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(payload));
  return base64url(new Uint8Array(sig));
}

function parseCookie(header, name) {
  if (!header) return '';
  const parts = header.split(';');
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return '';
}

function base64urlToString(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padLen);
  return atob(padded);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export async function verifySessionCookie(req) {
  const secret = process.env.CZ_SESSION_SECRET || '';
  if (!secret) return { ok: false, reason: 'missing_secret' };

  const raw = parseCookie(req.headers.get('cookie') || '', COOKIE_NAME);
  if (!raw) return { ok: false, reason: 'missing_cookie' };

  const [payloadB64, sig] = raw.split('.');
  if (!payloadB64 || !sig) return { ok: false, reason: 'bad_cookie' };

  let payloadJson = '';
  try {
    payloadJson = base64urlToString(payloadB64);
  } catch {
    return { ok: false, reason: 'bad_cookie' };
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'bad_cookie' };
  }

  const exp = Number(payload?.exp);
  const ip = String(payload?.ip || '');
  if (!Number.isFinite(exp) || !ip) return { ok: false, reason: 'bad_cookie' };
  if (Date.now() > exp) return { ok: false, reason: 'expired' };

  const expectedSig = await hmacSign(secret, payloadJson);
  if (!safeEqual(expectedSig, sig)) return { ok: false, reason: 'bad_sig' };

  // Bind to IP to make token reuse harder. (Not perfect behind NAT, but OK for this toy.)
  const reqIp = getClientIp(req);
  if (reqIp !== ip) return { ok: false, reason: 'ip_mismatch' };

  return { ok: true };
}

export default async function handler(req) {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, { status: 405 });
  }

  const secret = process.env.CZ_SESSION_SECRET || '';
  if (!secret) {
    return json({ error: 'Server misconfigured (CZ_SESSION_SECRET missing)' }, { status: 500 });
  }

  const ip = getClientIp(req);
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payloadJson = JSON.stringify({ exp, ip });
  const payloadB64 = base64url(utf8(payloadJson));
  const sig = await hmacSign(secret, payloadJson);
  const value = `${payloadB64}.${sig}`;

  const cookie = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ].join('; ');

  return json({ ok: true }, { status: 200, headers: { 'Set-Cookie': cookie } });
}
