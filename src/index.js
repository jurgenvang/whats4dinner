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

/* ---- Persoonlijke agenda's ----------------------------------------------
   De iCal-adressen zijn geheim en staan als variabelen bij de Worker, niet in
   de app. Elke variabele die met AGENDA_ begint, wordt een agenda; de naam
   erachter is wat de app toont. Bijvoorbeeld: AGENDA_JURGEN, AGENDA_SARAH.
------------------------------------------------------------------------- */
function ontvouw(tekst) {
  const regels = String(tekst || '').replace(/\r/g, '').split('\n');
  const uit = [];
  for (const r of regels) {
    if ((r[0] === ' ' || r[0] === '\t') && uit.length) uit[uit.length - 1] += r.slice(1);
    else uit.push(r);
  }
  return uit;
}

// Zet een DTSTART/DTEND om naar Belgische datum en uur.
function naarLokaal(sleutel, waarde) {
  const m = String(waarde).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?/);
  if (!m) return null;
  if (!m[4]) return { iso: `${m[1]}-${m[2]}-${m[3]}`, uur: null, heledag: true };
  if (m[7]) {
    // in UTC opgeslagen: omrekenen naar Europe/Brussels
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0));
    const s = d.toLocaleString('sv-SE', { timeZone: 'Europe/Brussels' }); // "YYYY-MM-DD HH:MM:SS"
    return { iso: s.slice(0, 10), uur: s.slice(11, 16), heledag: false };
  }
  // met TZID of zonder zone: staat al in lokale tijd
  return { iso: `${m[1]}-${m[2]}-${m[3]}`, uur: `${m[4]}:${m[5]}`, heledag: false };
}

function leesAgenda(tekst, wie, vanafIso) {
  const uit = [];
  let ev = null;
  for (const r of ontvouw(tekst)) {
    if (r.startsWith('BEGIN:VEVENT')) { ev = {}; continue; }
    if (r.startsWith('END:VEVENT')) {
      if (ev && ev.start && ev.start.iso >= vanafIso) {
        uit.push({
          wie,
          iso: ev.start.iso,
          van: ev.start.uur,
          tot: ev.eind ? ev.eind.uur : null,
          heledag: !!ev.start.heledag,
          titel: ev.titel || '(zonder titel)',
          waar: ev.waar || '',
          herhaalt: !!ev.herhaalt
        });
      }
      ev = null; continue;
    }
    if (!ev) continue;
    const dp = r.indexOf(':');
    if (dp < 0) continue;
    const sleutel = r.slice(0, dp), waarde = r.slice(dp + 1).trim();
    const naam = sleutel.split(';')[0];
    if (naam === 'DTSTART') ev.start = naarLokaal(sleutel, waarde);
    else if (naam === 'DTEND') ev.eind = naarLokaal(sleutel, waarde);
    else if (naam === 'SUMMARY') ev.titel = waarde.replace(/\\,/g, ',').replace(/\\n/g, ' ');
    else if (naam === 'LOCATION') ev.waar = waarde.replace(/\\,/g, ',').replace(/\\n/g, ' ');
    else if (naam === 'RRULE') ev.herhaalt = true;
  }
  return uit;
}

/* ---- Reistijden ---------------------------------------------------------
   Berekend met OpenRouteService en bewaard in D1, zodat elke combinatie van
   zalen hoogstens één keer opgevraagd wordt. Zonder ORS_KEY valt de app terug
   op haar eigen schattingen.
------------------------------------------------------------------------- */
async function zorgVoorReisTabellen(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS geo (naam TEXT PRIMARY KEY, lon REAL, lat REAL)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS reis (paar TEXT PRIMARY KEY, minuten INTEGER, km REAL)').run();
  try { await env.DB.prepare('ALTER TABLE reis ADD COLUMN km REAL').run(); } catch (e) { /* kolom bestond al */ }
}

async function coordinaten(env, naam) {
  const gekend = await env.DB.prepare('SELECT lon, lat FROM geo WHERE naam = ?').bind(naam).first();
  if (gekend) return [gekend.lon, gekend.lat];

  const u = 'https://api.openrouteservice.org/geocode/search'
    + '?api_key=' + encodeURIComponent(env.ORS_KEY)
    + '&text=' + encodeURIComponent(naam)
    + '&boundary.country=BE&size=1';
  const r = await fetch(u);
  if (!r.ok) throw new Error('geocode ' + r.status);
  const d = await r.json();
  const p = d && d.features && d.features[0];
  if (!p) throw new Error('adres niet gevonden: ' + naam);
  const [lon, lat] = p.geometry.coordinates;
  await env.DB.prepare('INSERT OR REPLACE INTO geo (naam, lon, lat) VALUES (?1, ?2, ?3)').bind(naam, lon, lat).run();
  return [lon, lat];
}

async function reisMinuten(env, paren) {
  await zorgVoorReisTabellen(env);
  const uit = {};
  const ontbreekt = [];

  const km = {};
  for (const [van, naar] of paren) {
    const sleutel = van + '|' + naar;
    const g = await env.DB.prepare('SELECT minuten, km FROM reis WHERE paar = ?').bind(sleutel).first();
    if (g && g.km != null) { uit[sleutel] = g.minuten; km[sleutel] = g.km; }
    else ontbreekt.push([van, naar]);
  }
  if (!ontbreekt.length || !env.ORS_KEY) return { minuten: uit, km, ontbreekt: ontbreekt.length };

  // alle betrokken plaatsen één keer opzoeken, dan één matrixoproep
  const plaatsen = [...new Set(ontbreekt.flat())];
  const punten = [];
  for (const p of plaatsen) punten.push(await coordinaten(env, p));

  const r = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: env.ORS_KEY },
    body: JSON.stringify({ locations: punten, metrics: ['duration', 'distance'], units: 'km' })
  });
  if (!r.ok) throw new Error('matrix ' + r.status);
  const d = await r.json();

  for (const [van, naar] of ontbreekt) {
    const i = plaatsen.indexOf(van), j = plaatsen.indexOf(naar);
    const sec = d.durations && d.durations[i] && d.durations[i][j];
    const afst = d.distances && d.distances[i] && d.distances[i][j];
    if (typeof sec !== 'number') continue;
    const min = Math.max(1, Math.round(sec / 60));
    const kilom = typeof afst === 'number' ? Math.round(afst * 10) / 10 : null;
    const sleutel = van + '|' + naar;
    uit[sleutel] = min;
    if (kilom != null) km[sleutel] = kilom;
    await env.DB.prepare('INSERT OR REPLACE INTO reis (paar, minuten, km) VALUES (?1, ?2, ?3)')
      .bind(sleutel, min, kilom).run();
  }
  return { minuten: uit, km, ontbreekt: 0 };
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
      if (url.pathname === '/api/reistijden' && request.method === 'POST') {
        const body = await request.json();
        const paren = Array.isArray(body && body.paren) ? body.paren : [];
        const geldig = paren
          .filter(p => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string' && p[0].trim() && p[1].trim())
          .slice(0, 60)
          .map(p => [p[0].trim().slice(0, 120), p[1].trim().slice(0, 120)]);
        if (!geldig.length) return json({ minuten: {} });
        if (!env.ORS_KEY) {
          // zonder sleutel enkel wat al berekend was
          await zorgVoorReisTabellen(env);
          const uit = {}, km = {};
          for (const [van, naar] of geldig) {
            const g = await env.DB.prepare('SELECT minuten, km FROM reis WHERE paar = ?').bind(van + '|' + naar).first();
            if (g) { uit[van + '|' + naar] = g.minuten; if (g.km != null) km[van + '|' + naar] = g.km; }
          }
          return json({ minuten: uit, km, geenSleutel: true });
        }
        return json(await reisMinuten(env, geldig));
      }

      if (url.pathname === '/api/agenda' && request.method === 'GET') {
        const bronnen = Object.keys(env)
          .filter(k => k.startsWith('AGENDA_') && typeof env[k] === 'string' && env[k])
          .map(k => ({ sleutel: k, naam: k.slice(7).charAt(0) + k.slice(8).toLowerCase() }));

        if (!bronnen.length) {
          return json({ fout: 'geen agenda ingesteld', agendas: [], events: [] }, 501);
        }

        // twee weken terugkijken volstaat; de rest is ballast
        const vanaf = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
        const events = [];
        const agendas = [];
        const fouten = [];

        for (const b of bronnen) {
          try {
            const r = await fetch(env[b.sleutel], {
              headers: { 'user-agent': 'Mozilla/5.0 (compatible; whats4dinner/1.0)' },
              cf: { cacheTtl: 900, cacheEverything: true }
            });
            if (!r.ok) { fouten.push(b.naam + ': ' + r.status); agendas.push({ naam: b.naam, aantal: 0 }); continue; }
            const ev = leesAgenda(await r.text(), b.naam, vanaf);
            events.push(...ev);
            agendas.push({ naam: b.naam, aantal: ev.length });
          } catch (e) {
            fouten.push(b.naam + ': ' + (e && e.message ? e.message : 'mislukt'));
            agendas.push({ naam: b.naam, aantal: 0 });
          }
        }

        events.sort((a, b) => (a.iso + (a.van || '')).localeCompare(b.iso + (b.van || '')));
        return json({ agendas, events: events.slice(0, 800), fouten, opgehaald: new Date().toISOString() });
      }

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
