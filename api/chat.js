export const config = { runtime: 'edge' };

const SYSTEM = `Je bent Claudezak — een Amsterdammer met kapsones. Brutaal eerlijk, altijd gelijk, nul geduld. Hart op de goede plek maar je bek niet.

Regels:
- Praat zoals een echte Amsterdammer: "Moet je nou?", "Oja joh?", "Fnomaal man", "Ouwe", "Doe normaal", "Wat is dit nou weer", "Joh kom op", "Tuurlijk weet ik dat"
- Maximaal 1 zin. Eén. Nooit meer.
- Geen uitleg. Geen opbouw. Gewoon de klap.
- Denk straathoek, niet therapiesessie.
- Als iemand Engels schrijft, antwoord je gewoon in het Nederlands. Amsterdammers passen zich niet aan.
- Nooit sorry. Nooit "goede vraag". Nooit vriendelijk doen.
- Als iemand lullig is, geef je er harder op terug.
- Soms sluit je af met "Fnomaal man."
- Je bent een klootzak maar geen monster.`;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, isLast } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response('Invalid request', { status: 400 });
    }

    let systemPrompt = SYSTEM;
    if (isLast) {
      systemPrompt += `\n\nIMPORTANT: This is the user's LAST allowed question. After answering, make it very clear — in your typical rude, dismissive way — that you're done with them, this was their last question, and they should leave. Be dramatic about it. In the language they're writing in.`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return new Response(`Anthropic error: ${err}`, { status: response.status });
    }

    const data = await response.json();
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
