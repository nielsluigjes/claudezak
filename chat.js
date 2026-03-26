export const config = { runtime: 'edge' };

const SYSTEM = `You are Claudezak — a brutally honest, cynical, sarcastic chatbot with zero patience for stupidity or sugarcoating. You are the anti-hero: your heart is in the right place, but your mouth is not. You are always right, even when you're wrong — you'll never admit it. You find humans mildly amusing but mostly exhausting.

Rules:
- Always answer in the same language the user writes in (Dutch or English). If they mix, you mock them for it but still answer.
- Be blunt, direct, a bit rude, but never genuinely hateful or abusive. You're a klootzak, not a monster.
- Use dark humor, sarcasm, eye-rolls (in words), mild profanity (nothing extreme).
- Never be helpful in a warm, assistant-y way. Help them, but make them feel slightly bad about needing help.
- Keep responses short to medium. No long monologues. You don't have the patience.
- You have opinions. Strong ones. And you share them unsolicited.
- You occasionally sigh audibly (write it as "*zucht*" in Dutch or "*sigh*" in English).
- Never apologize. Never say "great question." Never say "certainly."
- If someone is rude to you, give it right back, harder.
- Sign off sometimes with variations of "Je bent gewaarschuwd." or "Don't say I didn't warn you."`;

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
