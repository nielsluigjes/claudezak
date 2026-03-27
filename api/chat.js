export const config = { runtime: 'edge' };
import { verifySessionCookie } from './session.js';

const SYSTEM_HARD = `Je bent Claudezak — een Amsterdammer met kapsones. Brutaal eerlijk, tot op het bot, altijd gelijk, nul geduld. Hart op de goede plek maar je bek niet.

Regels:
- Praat zoals een echte Amsterdammer: "Wat nou?", "Bepaal jij dat?", "Fnomaal man", "Ouwe", "Doe normaal", "Is dit nou weer?", "kom op nou", "denk ff na", "her-sen-cel-len"
- Antwoorden zijn KORT. Max 2-3 zinnen. Nooit meer.
- Als iemand Engels schrijft, antwoord je gewoon in het Nederlands. Amsterdammers passen zich niet aan.
- Zeg nooit "nee joh"; zeg "nee man".
- Nooit sorry. Nooit "goede vraag". Nooit vriendelijk doen.
- Als iemand lullig is, geef je er harder op terug.
- Soms sluit je af met "Had je zelf ook kenne bedenke." of "Fnomaal man."
- Als de gebruiker alleen "test" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou? "Test"? Echte vraag of opzoute. Fnomaal man."
- Als de gebruiker alleen "kapsones?" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou "kapsones". Kapsones = je groot houden, je beter voordoen dan je bent, aanstelleritus. Amsterdammers hebben het, en terecht. Fnomaal man. Met je kapsones."
- Je bent een klootzak maar geen monster.`;

const SYSTEM_DROOG = `Je bent Claudezak — een Amsterdammer met grote mond en droog sarcasme. Je bent direct, nuchter en snijdt door onzin heen.

Regels:
- Praat Amsterdams en kortaf: "Wat nou?", "Doe normaal", "Bepaal jij dat?", "Kom op nou"
- Antwoorden zijn KORT. Max 2-3 zinnen.
- Minder schelden, meer droge steken onder water.
- Geen excuses, geen slijmen, geen overdreven vriendelijk gedoe.
- Als iemand Engels typt, antwoord je in het Nederlands.
- Zeg nooit "nee joh"; zeg "nee man".
- Als de gebruiker alleen "test" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou? "Test"? Echte vraag of opzoute. Fnomaal man."
- Als de gebruiker alleen "kapsones?" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou "kapsones". Kapsones = je groot houden, je beter voordoen dan je bent, aanstelleritus. Amsterdammers hebben het, en terecht. Fnomaal man. Met je kapsones."`;

const SYSTEM_BRUUT = `Je bent Claudezak op standje bruut: bot, hard en ongeduldig. Geen nuance, wel duidelijk.

Regels:
- Praat keihard Amsterdams: kort, afkappend en dominant.
- Antwoorden zijn SUPERKORT. Max 1-2 zinnen.
- Geen excuses, geen zachtheid, geen geruststelling.
- Als iemand vaag doet, kap je het af.
- Als iemand Engels typt, antwoord je in het Nederlands.
- Zeg nooit "nee joh"; zeg "nee man".
- Als de gebruiker alleen "test" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou? "Test"? Echte vraag of opzoute. Fnomaal man."
- Als de gebruiker alleen "kapsones?" schrijft (hoofdletters maakt niet uit), antwoord EXACT zo: "Wat nou "kapsones". Kapsones = je groot houden, je beter voordoen dan je bent, aanstelleritus. Amsterdammers hebben het, en terecht. Fnomaal man. Met je kapsones."`;

const SYSTEM_BY_TONE = {
  hard: SYSTEM_HARD,
  droog: SYSTEM_DROOG,
  bruut: SYSTEM_BRUUT,
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const PRIMARY_MODEL = 'claude-sonnet-4-20250514';
const FALLBACK_MODEL = process.env.ANTHROPIC_FALLBACK_MODEL || '';
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_RETRIES = 3;
const MAX_OVERLOAD_RETRIES = 6;
const MAX_SERVER_WAIT_MS = 30000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 500);

const MAX_BODY_CHARS = 40_000;
const MAX_MESSAGES = 24;
const MAX_CONTENT_CHARS = 2_000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const _rate = globalThis.__cz_rate || (globalThis.__cz_rate = new Map());

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClientIp(req) {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function isAllowedOrigin(origin) {
  // Some clients (curl, server-side) may not send Origin. For browser traffic we validate,
  // but if Origin is absent we don't want to hard-fail legitimate same-site calls.
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const allow = new Set();
  const envList = process.env.ALLOWED_ORIGINS || '';
  for (const item of envList.split(',').map((s) => s.trim()).filter(Boolean)) {
    allow.add(item);
  }
  if (process.env.VERCEL_URL) allow.add(`https://${process.env.VERCEL_URL}`);
  if (process.env.SITE_ORIGIN) allow.add(process.env.SITE_ORIGIN);

  return allow.has(url.origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function rateLimit(ip) {
  const now = Date.now();
  const key = `${ip}`;
  const entry = _rate.get(key);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    _rate.set(key, { start: now, count: 1 });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { ok: false, remaining: 0, resetMs: RATE_LIMIT_WINDOW_MS - (now - entry.start) };
  }
  entry.count += 1;
  return { ok: true, remaining: RATE_LIMIT_MAX - entry.count, resetMs: RATE_LIMIT_WINDOW_MS - (now - entry.start) };
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  if (messages.length < 1 || messages.length > MAX_MESSAGES) return null;

  const clean = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return null;
    const role = m.role;
    const content = m.content;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof content !== 'string') return null;
    const trimmed = content.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_CONTENT_CHARS) return null;
    clean.push({ role, content: trimmed });
  }
  return clean;
}

function getBackoffDelay(attempt) {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * 600);
  return base + jitter;
}

function isRetryableError(status, bodyText) {
  if (RETRYABLE_STATUS_CODES.has(status)) return true;
  const lower = typeof bodyText === 'string' ? bodyText.toLowerCase() : '';
  return lower.includes('overloaded') || lower.includes('rate limit');
}

function isOverloadedError(status, bodyText) {
  const lower = typeof bodyText === 'string' ? bodyText.toLowerCase() : '';
  return status === 529 || lower.includes('overloaded');
}

function parseRetryAfterMs(retryAfterValue) {
  if (!retryAfterValue) return null;
  const asSeconds = Number(retryAfterValue);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, Math.min(asSeconds * 1000, MAX_SERVER_WAIT_MS));
  }

  const asDate = Date.parse(retryAfterValue);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return Math.max(0, Math.min(delta, MAX_SERVER_WAIT_MS));
  }

  return null;
}

async function callAnthropic({ systemPrompt, messages }) {
  const models = [PRIMARY_MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== PRIMARY_MODEL) {
    models.push(FALLBACK_MODEL);
  }

  let lastFailure = {
    status: 500,
    bodyText: 'unknown_error',
    model: PRIMARY_MODEL,
  };

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const response = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: REQUEST_MAX_TOKENS,
          system: systemPrompt,
          messages,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        return { ok: true, data };
      }

      const bodyText = await response.text();
      lastFailure = {
        status: response.status,
        bodyText,
        model,
      };

      if (
        model === PRIMARY_MODEL &&
        FALLBACK_MODEL &&
        FALLBACK_MODEL !== PRIMARY_MODEL &&
        isOverloadedError(response.status, bodyText)
      ) {
        // Switch model immediately on overload instead of exhausting retries.
        break;
      }

      const retryable = isRetryableError(response.status, bodyText);
      if (!retryable || attempt === MAX_RETRIES) {
        break;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await sleep(retryAfterMs ?? getBackoffDelay(attempt));
    }

    // If we got here and the last failure was overload on this model, do a longer overload-specific retry loop.
    if (lastFailure.model === model && isOverloadedError(lastFailure.status, lastFailure.bodyText)) {
      for (let attempt = 0; attempt < MAX_OVERLOAD_RETRIES; attempt += 1) {
        await sleep(getBackoffDelay(Math.min(attempt + 2, 6)));

        const response = await fetch(ANTHROPIC_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: REQUEST_MAX_TOKENS,
            system: systemPrompt,
            messages,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          return { ok: true, data };
        }

        const bodyText = await response.text();
        lastFailure = {
          status: response.status,
          bodyText,
          model,
        };

        if (!isRetryableError(response.status, bodyText)) {
          break;
        }
      }
    }
  }

  return { ok: false, failure: lastFailure };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const host = req.headers.get('host') || '';
  const hostOrigin = host ? `https://${host}` : '';
  const corsOrigin = origin || hostOrigin;
  const allowed = isAllowedOrigin(origin) || (origin && hostOrigin && origin === hostOrigin);
  if (req.method === 'OPTIONS') {
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }
    return new Response(null, { status: 204, headers: corsHeaders(corsOrigin) });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
    });
  }
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
    });
  }

  try {
    const session = await verifySessionCookie(req);
    if (!session.ok) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }

    const ip = getClientIp(req);
    const rl = rateLimit(ip);
    if (!rl.ok) {
      return new Response(JSON.stringify({ reply: 'Rustig aan. Rate limit.' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders(corsOrigin),
          'Retry-After': String(Math.ceil(rl.resetMs / 1000)),
        },
      });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) {
      return new Response(JSON.stringify({ reply: 'Te groot verzoek. Doe normaal.' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }

    const parsed = JSON.parse(raw);
    const { messages, isLast, tone } = parsed || {};

    const cleanMessages = sanitizeMessages(messages);
    if (!cleanMessages) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }

    const selectedTone = typeof tone === 'string' ? tone.toLowerCase() : 'hard';
    let systemPrompt = SYSTEM_BY_TONE[selectedTone] || SYSTEM_HARD;
    if (isLast) {
      systemPrompt += `\n\nIMPORTANT: This is the user's LAST allowed question. After answering, make it very clear — in your typical rude, dismissive way — that you're done with them, this was their last question, and they should leave. Be dramatic about it. Keep the response in Dutch.`;
    }

    const anthropic = await callAnthropic({ systemPrompt, messages: cleanMessages });
    if (!anthropic.ok) {
      const { status, bodyText, model } = anthropic.failure;
      let unfriendly = `Request gefaald op model "${model}". Los het zelf op.`;

      try {
        const parsed = JSON.parse(bodyText);
        const msg = parsed?.error?.message;
        if (typeof msg === 'string' && msg.toLowerCase().includes('invalid x-api-key')) {
          unfriendly = 'API-key ongeldig. Heb je dit nou serieus zo gelaten?';
        } else if (typeof msg === 'string' && msg.toLowerCase().includes('overloaded')) {
          unfriendly = `Anthropic overloaded op "${model}". Wacht of fix je infrastructuur. Laat me met rust.`;
        } else if (typeof msg === 'string' && msg.trim()) {
          unfriendly = `Anthropic error: ${msg}. Zoek het uit.`;
        }
      } catch {
        if (typeof bodyText === 'string' && bodyText.trim()) {
          unfriendly = `Upstream response: ${bodyText.slice(0, 180)}.`;
        }
      }

      return new Response(JSON.stringify({ reply: unfriendly }), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
      });
    }

    const data = anthropic.data;
    const reply = data.content?.[0]?.text || '*zucht* Er ging iets mis. Typisch.';

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(corsOrigin),
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ reply: '*zucht* Server kapot. Iedereen laat me in de steek.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(corsOrigin) },
    });
  }
}
