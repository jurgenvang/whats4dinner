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
