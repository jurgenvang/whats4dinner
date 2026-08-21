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

// Verbruiksteller voor de Claude-oproepen. Twee vensters: per dag en per minuut.
// De tabel wordt aangemaakt zodra ze voor het eerst nodig is.
async function tel(env, sleutel) {
  const zet = async () => {
    await env.DB.prepare(
      `INSERT INTO usage (k, n) VALUES (?1, 1)
       ON CONFLICT(k) DO UPDATE SET n = n + 1`
    ).bind(sleutel).run();
    const r = await env.DB.prepare('SELECT n FROM usage WHERE k = ?').bind(sleutel).first();
    return r ? r.n : 1;
  };
  try {
    return await zet();
  } catch (e) {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS usage (k TEXT PRIMARY KEY, n INTEGER NOT NULL)').run();
    return await zet();
  }
}

async function verbruikVandaag(env, dagSleutel) {
  try {
    const r = await env.DB.prepare('SELECT n FROM usage WHERE k = ?').bind(dagSleutel).first();
    return r ? r.n : 0;
  } catch (e) { return 0; }
}

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

        // Throttle: standaard 40 per dag en 6 per minuut, aanpasbaar met variabelen
        const perDag = Number(env.SUGGEST_PER_DAG) || 40;
        const perMinuut = Number(env.SUGGEST_PER_MINUUT) || 6;
        const nu = new Date().toISOString();
        const dagK = 'dag:' + nu.slice(0, 10);
        const minK = 'min:' + nu.slice(0, 16);

        const nDag = await tel(env, dagK);
        if (nDag > perDag) {
          return json({ fout: 'daglimiet bereikt (' + perDag + ' suggesties). Morgen weer.', limiet: true }, 429);
        }
        const nMin = await tel(env, minK);
        if (nMin > perMinuut) {
          return json({ fout: 'even te snel achter elkaar. Probeer over een minuut opnieuw.', limiet: true }, 429);
        }

        // Oude minuutrijen opruimen zodat de tabel niet aangroeit
        try {
          await env.DB.prepare("DELETE FROM usage WHERE k LIKE 'min:%' AND k < ?").bind('min:' + nu.slice(0, 10)).run();
        } catch (e) {}

        const systeem = [
          'Je krijgt de naam van een gerecht uit een Vlaams gezin.',
          'Antwoord uitsluitend met JSON, zonder uitleg en zonder markdown:',
          '{"ing":[{"n":"kipfilet","q":600,"u":"g","c":"vlees"}],',
          ' "bron":"kip","opwarm":true,"tijd":35,"eiwit":"hoog","slots":["diner"],',
          ' "prep":true,"instant":false,"alleen":null,"tip":"korte tip of leeg"}',
          'Regels:',
          '- hoeveelheden voor 4 personen',
          '- tijd is de actieve kooktijd in minuten, een getal tussen 5 en 240',
          '- eiwit is "hoog" of "gemiddeld", naargelang het gerecht veel eiwit levert',
          '- slots is ["diner"], ["lunch"] of ["lunch","diner"]: wanneer past dit gerecht',
          '- prep is true als het gerecht (deels) een dag vooraf gemaakt kan worden',
          '- instant is true als het enkel nog opgewarmd moet worden, zoals diepvries of afhaal',
          '- alleen is null, "weekend" of "zondag" voor gerechten die enkel dan passen',
          '- tip is hoogstens een korte zin, of laat leeg',
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
          const parsed = JSON.parse(tekst.replace(/```json|```/g, '').trim());
          parsed._model = env.SUGGEST_MODEL || 'claude-haiku-4-5-20251001';
          parsed._gebruik = { vandaag: nDag, limiet: perDag };
          return json(parsed);
        } catch (e) {
          return json({ fout: 'onleesbaar antwoord' }, 502);
        }
      }

      if (url.pathname === '/api/kalender' && request.method === 'GET') {
        // Doorgeefluik voor de wedstrijdkalenders: de browser mag die zelf niet ophalen.
        const doel = url.searchParams.get('url') || '';
        let u;
        try { u = new URL(doel); } catch (e) { return json({ fout: 'ongeldige url' }, 400); }
        if (u.protocol !== 'https:' || !/(^|\.)wisseq\.eu$/.test(u.hostname)) {
          return json({ fout: 'enkel kalenders van wisseq.eu' }, 403);
        }
        const r = await fetch(u.toString(), {
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; whats4dinner/1.0)',
            'accept': 'text/calendar, text/plain, */*'
          },
          cf: { cacheTtl: 1800, cacheEverything: true }
        });
        if (!r.ok) return json({ fout: 'kalender antwoordde met ' + r.status }, 502);
        const tekst = await r.text();
        return new Response(tekst, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
        });
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
