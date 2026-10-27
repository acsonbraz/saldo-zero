/* Saldo Zero · demo estática. Simula a API do servidor no próprio navegador (localStorage), para o jogo rodar
 * em hospedagem estática (GitHub Pages) sem backend. Contas, ranking e loja são só de mentira: nada sai do aparelho. */
(function () {
  var KEY = 'sz-demo-db-v1';
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  var origFetch = window.fetch.bind(window);
  function reply(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'content-type': 'application/json' } }));
  }
  function user(db) {
    return { id: 1, nick: db.nick, createdAt: db.createdAt || Date.now(), progress: db.progress || {}, favores: db.favores == null ? 10 : db.favores, email: null, emailVerified: false, vip: false };
  }
  function bodyOf(opts) { try { return JSON.parse((opts && opts.body) || '{}'); } catch (e) { return {}; } }
  window.fetch = function (input, opts) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    var path = url.pathname.slice(url.pathname.indexOf('/api/'));
    if (url.pathname.indexOf('/api/') === -1) return origFetch(input, opts);
    var method = ((opts && opts.method) || 'GET').toUpperCase();
    var db = load(), body = bodyOf(opts);
    if (path === '/api/store/config') return reply({ enabled: false, provider: 'demo', env: 'demo', products: [], mail: false });
    if (path === '/api/auth/check') return reply({ nick: url.searchParams.get('nick') || '', available: true });
    if (path === '/api/auth/enter') {
      db.nick = String(body.nick || 'Jogador').slice(0, 20); db.createdAt = db.createdAt || Date.now(); db.favores = db.favores == null ? 10 : db.favores; save(db);
      return reply({ token: 'demo', user: user(db), created: !!body.create, entitlements: [] });
    }
    if (path === '/api/auth/logout' || path === '/api/auth/logout-all') return reply({ ok: true });
    if (path.indexOf('/api/auth/') === 0) return reply({ error: 'Indisponível na demo.' }, 400);
    if (path === '/api/me' && method === 'GET') return db.nick ? reply({ user: user(db), entitlements: [], run: db.run || null }) : reply({ error: 'Entre para continuar.' }, 401);
    if (path === '/api/me' && method === 'DELETE') { localStorage.removeItem(KEY); return reply({ ok: true }); }
    if (path === '/api/me/run') { db.run = { state: body.state, at: Date.now() }; save(db); return reply({ ok: true }); }
    if (path === '/api/me/progress') { db.progress = body; save(db); return reply({ progress: body }); }
    if (path === '/api/favores/spend') { db.favores = Math.max(0, (db.favores == null ? 10 : db.favores) - (Number(body.n) || 0)); save(db); return reply({ favores: db.favores }); }
    if (path === '/api/daily' && method === 'POST') {
      db.daily = db.daily || {}; var d = body.day, old = db.daily[d];
      if (!old || body.days > old.days) db.daily[d] = { days: body.days, ending: body.ending, turns: body.turns || 0 };
      save(db); return reply(board(db, d));
    }
    if (path === '/api/daily') return reply(board(db, url.searchParams.get('day')));
    if (path === '/api/support' && method === 'GET') return reply({ tickets: [] });
    if (path === '/api/support') return reply({ ok: true, id: 1 });
    return reply({ error: 'Indisponível na demo.' }, 404);
  };
  function board(db, day) {
    var mine = db.daily && db.daily[day];
    return { day: day, total: mine ? 1 : 0, top: mine ? [{ nick: db.nick, days: mine.days, ending: mine.ending, turns: mine.turns, vip: 0 }] : [], me: mine ? { rank: 1, days: mine.days, ending: mine.ending, percentile: 100 } : null };
  }
})();
