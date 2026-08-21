/**
 * whats4dinner — Cloudflare Worker
 *
 * Serveert de app (public/index.html) en een kleine API erbovenop:
 *   GET  /api/state  -> { rev, data }
 *   PUT  /api/state  -> { rev }            body: { rev, data }
 *   GET  /api/rev    -> { rev }            goedkope controle voor de app
 *
 * Alles zit in één rij in D1. Bij het bewaren stuurt de app het revisienummer mee
 * dat ze laatst zag. Klopt dat niet meer, dan heeft iemand anders ondertussen
 * bewaard en krijgt de app een 409 met de nieuwste versie terug, in plaats van
 * die stilletjes te overschrijven.
 *
 * Zet een wachtwoord met:  npx wrangler secret put MENU_KEY
 * Zonder MENU_KEY is de app voor iedereen met de link leesbaar én bewerkbaar.
 */

const ROW = 'gezin';
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function huidige(env) {
  const r = await env.DB.prepare('SELECT rev, data FROM state WHERE id = ?').bind(ROW).first();
  return r ? { rev: r.rev, data: JSON.parse(r.data) } : { rev: 0, data: null };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    // Wachtwoord, als er een ingesteld is
    if (env.MENU_KEY && request.headers.get('x-menu-key') !== env.MENU_KEY) {
      return json({ fout: 'geen toegang' }, 401);
    }

    try {
      if (url.pathname === '/api/rev' && request.method === 'GET') {
        const r = await env.DB.prepare('SELECT rev FROM state WHERE id = ?').bind(ROW).first();
        return json({ rev: r ? r.rev : 0 });
      }

      if (url.pathname === '/api/state' && request.method === 'GET') {
        return json(await huidige(env));
      }

      if (url.pathname === '/api/suggest' && request.method === 'POST') {
        // Optioneel. Zonder ANTHROPIC_API_KEY valt de app terug op haar eigen woordenlijst.
        if (!env.ANTHROPIC_API_KEY) return json({ fout: 'geen sleutel ingesteld' }, 501);

        const body = await request.json();
        const naam = body && typeof body.naam === 'string' ? body.naam.trim().slice(0, 120) : '';
        if (!naam) return json({ fout: 'geen naam' }, 400);

        const systeem = [
          'Je krijgt de naam van een gerecht uit een Vlaams gezin.',
          'Antwoord uitsluitend met JSON, zonder uitleg en zonder markdown:',
          '{"ing":[{"n":"kipfilet","q":600,"u":"g","c":"vlees"}],"bron":"kip","opwarm":true}',
          'Regels:',
          '- hoeveelheden voor 4 personen',
          '- u is een van: g, kg, ml, l, st, el, tl, blik, pot, bosje, sneden, teentjes, rol, snuf',
          '- c is een van: groenten, vlees, zuivel, droog, brood, diepvries, overig',
          '- bron is een van: kip, rund, varken, kalkoen, vis, garnaal, ei, peulvrucht, tofu, kaas, gemengd',
          '- opwarm is true als het gerecht zonder kwaliteitsverlies opgewarmd kan worden',
          '- 5 tot 10 ingredienten, Nederlandse namen zoals in een Belgische supermarkt',
          '- laat basiszaken als peper en zout weg'
        ].join('\n');

        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            system: systeem,
            messages: [{ role: 'user', content: naam }]
          })
        });

        if (!r.ok) return json({ fout: 'Claude API gaf ' + r.status }, 502);
        const d = await r.json();
        const tekst = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
        try {
          return json(JSON.parse(tekst.replace(/```json|```/g, '').trim()));
        } catch (e) {
          return json({ fout: 'onleesbaar antwoord' }, 502);
        }
      }

      if (url.pathname === '/api/state' && request.method === 'PUT') {
        const body = await request.json();
        if (!body || typeof body.data !== 'object' || body.data === null) {
          return json({ fout: 'geen geldige inhoud' }, 400);
        }
        const verwacht = Number(body.rev) || 0;
        const nu = await huidige(env);

        if (nu.rev !== verwacht) {
          return json(nu, 409); // iemand anders was sneller
        }

        const nieuw = nu.rev + 1;
        await env.DB.prepare(
          `INSERT INTO state (id, rev, data, updated)
             VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(id) DO UPDATE SET rev = ?2, data = ?3, updated = ?4`
        ).bind(ROW, nieuw, JSON.stringify(body.data), new Date().toISOString()).run();

        return json({ rev: nieuw });
      }
    } catch (e) {
      return json({ fout: String(e && e.message ? e.message : e) }, 500);
    }

    return json({ fout: 'onbekend pad' }, 404);
  },
};
