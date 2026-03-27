export const config = { runtime: 'edge' };

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffDelay(attempt) {
  const base = 1000 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 300);
  return base + jitter;
}

function isRetryableError(status, bodyText) {
  if (RETRYABLE_STATUS_CODES.has(status)) return true;
  const lower = typeof bodyText === 'string' ? bodyText.toLowerCase() : '';
  return lower.includes('overloaded') || lower.includes('rate limit');
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
          max_tokens: 1000,
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

      const retryable = isRetryableError(response.status, bodyText);
      if (!retryable || attempt === MAX_RETRIES) {
        break;
      }

      await sleep(getBackoffDelay(attempt));
    }
  }

  return { ok: false, failure: lastFailure };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, isLast, tone } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response('Invalid request', { status: 400 });
    }

    const selectedTone = typeof tone === 'string' ? tone.toLowerCase() : 'hard';
    let systemPrompt = SYSTEM_BY_TONE[selectedTone] || SYSTEM_HARD;
    if (isLast) {
      systemPrompt += `\n\nIMPORTANT: This is the user's LAST allowed question. After answering, make it very clear — in your typical rude, dismissive way — that you're done with them, this was their last question, and they should leave. Be dramatic about it. Keep the response in Dutch.`;
    }

    const anthropic = await callAnthropic({ systemPrompt, messages });
    if (!anthropic.ok) {
      const { status, bodyText, model } = anthropic.failure;
      let unfriendly = `Request gefaald op model "${model}". Los het zelf op.`;

      try {
        const parsed = JSON.parse(bodyText);
        const msg = parsed?.error?.message;
        if (typeof msg === 'string' && msg.toLowerCase().includes('invalid x-api-key')) {
          unfriendly = 'API-key ongeldig. Heb je dit nou serieus zo gelaten?';
        } else if (typeof msg === 'string' && msg.toLowerCase().includes('overloaded')) {
          unfriendly = `Anthropic overloaded. Wacht of fix je infrastructuur. Laat me met rust.`;
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
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = anthropic.data;
    const reply = data.content?.[0]?.text || '*zucht* Er ging iets mis. Typisch.';

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ reply: '*zucht* Server kapot. Iedereen laat me in de steek.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
