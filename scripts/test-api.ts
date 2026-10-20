// Testes de API com asserts (sem navegador). Sobe sozinho o Asaas falso e o servidor em portas próprias, com banco
// temporário, e derruba tudo no fim. Uso: bun scripts/test-api.ts   (ou bun run test)
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const SRV_PORT = 3325, FAKE_PORT = 3331;
const BASE = "http://127.0.0.1:" + SRV_PORT, FAKE = "http://127.0.0.1:" + FAKE_PORT;
const HOOK_TOKEN = "tok-de-teste-1234";
const DATA = mkdtempSync(join(tmpdir(), "sz-test-"));

let passed = 0, failed = 0;
function ok(cond: unknown, name: string, extra?: unknown) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

// ---- banco "antigo" (schema anterior): sessão com token em claro, PIN de 4 dígitos e pagamento duplicado ----
const LEGACY_TOKEN = "legacy" + "x".repeat(50);
{
  const db = new Database(join(DATA, "saldozero.sqlite"), { create: true });
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL UNIQUE, nick_display TEXT NOT NULL, pin_hash TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE entitlements (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, product_id TEXT NOT NULL, payment_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, payment_id));`);
  const h = await Bun.password.hash("4826", { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
  db.run("INSERT INTO users (nick, nick_display, pin_hash, created_at, last_seen) VALUES ('legado', 'Legado', ?, 1, 1)", [h]);
  db.run("INSERT INTO users (nick, nick_display, pin_hash, created_at, last_seen) VALUES ('legado2', 'Legado2', ?, 1, 1)", [h]);
  db.run("INSERT INTO sessions VALUES (?, 1, ?, ?)", [LEGACY_TOKEN, Date.now(), Date.now()]);
  db.run("INSERT INTO entitlements VALUES (1, 'com.saldozero.vip', 'pay_dup', 1), (2, 'com.saldozero.vip', 'pay_dup', 2)");
  db.close();
}

const env = { ...process.env, PORT: String(SRV_PORT), DATA_DIR: DATA, DEV_CODES: "1", ASAAS_API_KEY: "test", ASAAS_ENV: "sandbox", ASAAS_BASE_URL: FAKE + "/v3", ASAAS_WEBHOOK_TOKEN: HOOK_TOKEN, SITE_URL: BASE, TRUST_PROXY: "1", ADMIN_TOKEN: "admin-token-de-teste-123", RECONCILE_FIRST_MS: "300" } as Record<string, string>;
const fake = Bun.spawn(["bun", ROOT + "scripts/fake-asaas.ts"], { env: { ...process.env, FAKE_PORT: String(FAKE_PORT), FAKE_WEBHOOK_URL: BASE + "/api/webhook/asaas", FAKE_WEBHOOK_TOKEN: HOOK_TOKEN }, stdout: "ignore", stderr: "inherit" });
let server: ReturnType<typeof Bun.spawn> | null = null;
async function startServer() {
  server = Bun.spawn(["bun", ROOT + "server.ts"], { env, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(BASE + "/health")).ok) return; } catch {} await Bun.sleep(100); }
  throw new Error("servidor não subiu");
}
async function stopServer() { server?.kill("SIGTERM"); await server?.exited; }

let ipN = 0;
const freshIP = () => "10.0." + Math.floor(++ipN / 250) + "." + (ipN % 250);
async function call(method: string, path: string, body?: unknown, token?: string, ip = "10.9.9.9", headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-real-ip": ip, ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: any = null; try { data = await r.json(); } catch {}
  return { status: r.status, data, headers: r.headers };
}
async function signup(nick: string, pin: string, email?: string) {
  const ip = freshIP();
  await call("POST", "/api/auth/enter", { nick, pin }, undefined, ip);
  return call("POST", "/api/auth/enter", { nick, pin, create: true, email }, undefined, ip);
}
async function verifiedUser(nick: string, pin: string) {
  const r = await signup(nick, pin, nick + "@exemplo.com");
  const v = await call("POST", "/api/auth/verify", { code: r.data.devCode }, r.data.token, freshIP());
  if (v.status !== 200) throw new Error("verify falhou " + JSON.stringify(v.data));
  return r.data.token as string;
}
const me = (t: string) => call("GET", "/api/me", undefined, t, freshIP());
const spDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

try {
  await Bun.sleep(300);
  await startServer();

  console.log("\n# infraestrutura e cabeçalhos");
  const home = await fetch(BASE + "/");
  const cspH = home.headers.get("content-security-policy") || "";
  ok(home.status === 200, "GET / 200");
  ok(/frame-ancestors 'none'/.test(cspH) && /script-src 'self' 'sha256-/.test(cspH) && !/unsafe-eval/.test(cspH) && !/script-src[^;]*unsafe-inline/.test(cspH), "CSP restritiva com hash dos scripts", cspH);
  ok(home.headers.get("strict-transport-security")?.includes("max-age"), "HSTS");
  ok(home.headers.get("x-content-type-options") === "nosniff", "nosniff");
  ok(!!home.headers.get("referrer-policy"), "Referrer-Policy");
  const homeHtml = await home.text();
  ok(homeHtml.includes("Você é o banqueiro. Quantos dias até a PF chegar?"), "og:title com a promessa");
  ok(!homeHtml.includes("fonts.googleapis.com"), "sem Google Fonts");
  ok((await fetch(BASE + "/health")).status === 200, "GET /health");
  const priv = await (await fetch(BASE + "/privacidade")).text();
  ok(priv.includes("EBENIX TECNOLOGIA INOVA SIMPLES (I.S.)") && priv.includes("68.730.443/0001-71") && priv.includes("art. 7º, V") && priv.includes("art. 14"), "privacidade: controlador, base legal, menores");
  const sup = await (await fetch(BASE + "/suporte")).text();
  ok(sup.includes("68.730.443/0001-71") && sup.includes("Nunca pedimos a senha") && !sup.includes("Esqueci o PIN"), "suporte identifica fornecedor, fala em senha e não pede a senha");
  ok(!priv.includes("<b>PIN</b>") && priv.includes("<b>senha</b> guardada apenas como hash"), "privacidade fala em senha (não PIN)");
  const font = await fetch(BASE + "/fonts/Anton.woff2");
  ok(!(font.headers.get("cache-control") || "").includes("immutable"), "fontes sem cache immutable");
  const sw = await (await fetch(BASE + "/sw.js")).text();
  ok(sw.includes("url.pathname === '/'") && sw.includes("NET_TIMEOUT = 3000"), "service worker: só '/' e timeout 3 s");
  {
    const shell = sw.slice(sw.indexOf("const SHELL"), sw.indexOf("];", sw.indexOf("const SHELL")));
    ok(!shell.includes("/audio/") && !shell.includes("/intro/") && sw.includes("url.pathname.startsWith('/audio/')") && sw.includes("url.pathname.startsWith('/intro/')"), "service worker: áudio e intro só em runtime, fora da instalação");
    const js = await fetch(BASE + "/js/game-audio.js"), js2 = await fetch(BASE + "/js/intro-player.js");
    ok(js.status === 200 && (js.headers.get("content-type") || "").includes("javascript") && js2.status === 200, "scripts de áudio e intro servidos");
    ok(/media-src 'self'/.test(cspH), "CSP permite mídia do próprio site");
  }

  console.log("\n# migração do banco antigo");
  const lm = await me(LEGACY_TOKEN);
  ok(lm.status === 200 && lm.data.user.nick === "Legado", "sessão antiga continua válida após migrar para hash", lm.data);
  const lg = await call("POST", "/api/auth/enter", { nick: "legado", pin: "4826" }, undefined, freshIP());
  ok(lg.status === 200, "PIN antigo de 4 dígitos ainda entra", lg.data);
  ok((await call("POST", "/api/auth/enter", { nick: "legado2", pin: "4825" }, undefined, freshIP())).status === 401, "PIN antigo errado: 401 (senha incorreta)");
  {
    const db = new Database(join(DATA, "saldozero.sqlite"), { readonly: true });
    const cols = (db.query("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
    ok(cols.includes("token_hash") && !cols.includes("token"), "sessões guardam só hash");
    const raw = db.query("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(LEGACY_TOKEN) as any;
    ok(raw.n === 0, "token em claro não está no banco");
    const dup = db.query("SELECT user_id FROM entitlements WHERE payment_id = 'pay_dup'").all() as any[];
    ok(dup.length === 1 && dup[0].user_id === 1, "pagamento duplicado: mantém a primeira conta", dup);
    db.close();
  }

  console.log("\n# cadastro e senha");
  ok((await signup("pin_curto", "2719")).status === 400, "conta nova recusa PIN de 4 dígitos");
  ok((await signup("pin_obvio", "123456")).status === 400, "conta nova recusa só números (123456)");
  ok((await signup("pin_obvio2", "000000")).status === 400, "conta nova recusa 000000");
  ok((await signup("pin_obvio3", "640218")).status === 400, "conta nova recusa PIN numérico forte (precisa de letras)");
  ok((await signup("so_letras", "abcdefgh")).status === 400, "conta nova recusa senha só com letras");
  const weak = await signup("fraca_t", "abc123");
  ok(weak.status === 400 && /fácil de adivinhar/.test(weak.data?.error || ""), "conta nova recusa senha óbvia abc123", weak.data);
  ok((await signup("fraca_t2", "senha123")).status === 400, "conta nova recusa senha123");
  ok((await signup("fraca_t3", "aaa111")).status === 400, "conta nova recusa repetição aaa111");
  ok((await signup("zeca_t", "zeca_t99")).status === 400, "conta nova recusa senha com o apelido");
  ok((await signup("curta_t", "ab1")).status === 400, "conta nova recusa senha de 3 caracteres");
  ok((await signup("longa_t", "a1" + "x".repeat(70))).status === 400, "conta nova recusa senha acima de 64");
  ok((await signup("espaco_t", " tucano42")).status === 400, "conta nova recusa espaço nas pontas");
  const good = await signup("senha_ok", "tucano42");
  ok(good.status === 200 && good.data.created === true, "conta nova com senha forte (letras + números)", good.data);
  ok((await call("POST", "/api/auth/enter", { nick: "senha_ok", pin: "tucano42" }, undefined, freshIP())).status === 200, "senha nova entra");
  const wrong = await call("POST", "/api/auth/enter", { nick: "senha_ok", pin: "tucano43" }, undefined, freshIP());
  ok(wrong.status === 401 && /Senha incorreta/.test(wrong.data?.error || ""), "senha errada: 401 com mensagem em português", wrong.data);
  ok((await call("POST", "/api/auth/enter", { nick: "senha_ok", pin: "Frase longa com espaços 2026" }, undefined, freshIP())).status === 401, "login aceita qualquer texto de 4 a 64 (sem 400)");
  const tA = await verifiedUser("alice_t", "maleta75");
  const tB = await verifiedUser("bruno_t", "jatinho64");
  ok(!!tA && !!tB, "duas contas confirmadas");
  const dup = await signup("dora_t", "charuto58", "alice_t@exemplo.com");
  ok(dup.status === 200 && typeof dup.data.sent === "boolean" && !dup.data.devCode, "e-mail já confirmado em outra conta: resposta genérica, sem código", dup.data);

  console.log("\n# loja: checkout, pedido só do dono, webhook");
  const CPF_A = "529.982.247-25";
  const co = await call("POST", "/api/checkout", { productId: "com.saldozero.favores10", name: "Alice Teste", email: "a@exemplo.com", cpfCnpj: CPF_A }, tA, freshIP());
  ok(co.status === 200 && co.data.paymentId, "checkout criado", co.data);
  const pid = co.data.paymentId as string;
  ok((await call("GET", "/api/order/" + pid, undefined, undefined, freshIP())).status === 401, "pedido sem login = 401");
  ok((await call("GET", "/api/order/" + pid, undefined, tB, freshIP())).status === 404, "pedido de outra conta = 404");
  const pend = await call("GET", "/api/order/" + encodeURIComponent(co.data.ref), undefined, tA, freshIP());
  ok(pend.status === 200 && pend.data.paid === false, "dono vê o pedido pendente (pelo banco local)", pend.data);
  // webhook forjado: corpo diz RECEIVED, mas o Asaas diz PENDING -> nada liberado
  await call("POST", "/api/webhook/asaas", { event: "PAYMENT_RECEIVED", payment: { id: pid, status: "RECEIVED", externalReference: co.data.ref } }, undefined, freshIP(), { "asaas-access-token": HOOK_TOKEN });
  ok((await me(tA)).data.user.favores === 0, "webhook com corpo forjado não libera (reconsulta o Asaas)");
  ok((await call("POST", "/api/webhook/asaas", { event: "X", payment: { id: pid } }, undefined, freshIP(), { "asaas-access-token": "errado-errado-1" })).status === 401, "webhook com token errado = 401");
  const hookErr = await call("POST", "/api/webhook/asaas", { event: "PAYMENT_RECEIVED", payment: { id: "pay_inexistente" } }, undefined, freshIP(), { "asaas-access-token": HOOK_TOKEN });
  ok(hookErr.status === 200, "webhook com erro de processamento responde 200");
  await fetch(FAKE + "/_test/pay/" + pid, { method: "POST" });
  const paid = await call("GET", "/api/order/" + pid, undefined, tA, freshIP());
  ok(paid.data.paid === true && paid.data.granted === true, "webhook real libera; pedido pago e creditado", paid.data);
  ok((await me(tA)).data.user.favores === 10, "10 favores na conta A");

  console.log("\n# restauração");
  ok((await call("POST", "/api/restore", { cpfCnpj: CPF_A }, undefined, freshIP())).status === 401, "restore sem login = 401");
  const rB = await call("POST", "/api/restore", { cpfCnpj: CPF_A }, tB, freshIP());
  const meB = await me(tB);
  ok(rB.status === 200 && rB.data.count === 0 && meB.data.user.favores === 0 && meB.data.entitlements.length === 0, "restore com CPF de terceiro: nada concedido", { r: rB.data, me: meB.data.user.favores });
  const rA = await call("POST", "/api/restore", { cpfCnpj: CPF_A }, tA, freshIP());
  ok(rA.data.count === 1 && (await me(tA)).data.user.favores === 10, "restore do dono não credita de novo", rA.data);
  // compra "antiga" sem pedido local (sem dono), CPF Y: a primeira conta que restaurar fica com ela; a segunda não ganha nada
  const CPF_Y = "11144477735";
  const cus = await (await fetch(FAKE + "/v3/customers", { method: "POST", headers: { access_token: "test", "content-type": "application/json" }, body: JSON.stringify({ name: "Y", email: "y@exemplo.com", cpfCnpj: CPF_Y }) })).json();
  const legacyPay = await (await fetch(FAKE + "/v3/payments", { method: "POST", headers: { access_token: "test", "content-type": "application/json" }, body: JSON.stringify({ customer: cus.id, value: 19.9, externalReference: "sz:com.saldozero.favores30:legacy01" }) })).json();
  await fetch(FAKE + "/_test/pay/" + legacyPay.id + "?silent=1", { method: "POST" });
  const r1 = await call("POST", "/api/restore", { cpfCnpj: CPF_Y }, tA, freshIP());
  const r2 = await call("POST", "/api/restore", { cpfCnpj: CPF_Y }, tB, freshIP());
  const fa = (await me(tA)).data.user.favores, fb = (await me(tB)).data.user.favores;
  ok(r1.data.count === 1 && r2.data.count === 0 && fa === 40 && fb === 0, "pagamento resgatado em 2 contas credita só 1", { r1: r1.data, r2: r2.data, fa, fb });

  console.log("\n# não consumível, /api/me como fonte, estorno");
  const deck = await call("POST", "/api/checkout", { productId: "com.saldozero.deck.eleicao", name: "Alice Teste", email: "a@exemplo.com", cpfCnpj: CPF_A }, tA, freshIP());
  await fetch(FAKE + "/_test/pay/" + deck.data.paymentId, { method: "POST" });
  ok((await me(tA)).data.entitlements.includes("com.saldozero.deck.eleicao"), "/api/me mostra o baralho");
  await fetch(FAKE + "/v3/payments/" + deck.data.paymentId + "/refund", { method: "POST", headers: { access_token: "test" } });
  ok(!(await me(tA)).data.entitlements.includes("com.saldozero.deck.eleicao"), "estorno revoga o baralho");
  await fetch(FAKE + "/v3/payments/" + pid + "/refund", { method: "POST", headers: { access_token: "test" } });
  ok((await me(tA)).data.user.favores === 30, "estorno dos 10 favores desconta da conta (40 -> 30)");
  const after = await call("GET", "/api/order/" + pid, undefined, tA, freshIP());
  ok(after.data.status === "REFUNDED" && after.data.granted === false, "pedido estornado fica REFUNDED", after.data);

  console.log("\n# conciliação (aviso do Asaas perdido)");
  const lost = await call("POST", "/api/checkout", { productId: "com.saldozero.favores10", name: "Alice Teste", email: "a@exemplo.com", cpfCnpj: CPF_A }, tA, freshIP());
  await fetch(FAKE + "/_test/pay/" + lost.data.paymentId + "?silent=1", { method: "POST" });
  const before = (await me(tA)).data.user.favores;
  await stopServer();
  await startServer();
  await Bun.sleep(2000);
  const afterRec = (await me(tA)).data.user.favores;
  ok(afterRec === before + 10, "pagamento sem webhook é liberado pela conciliação", { before, afterRec });

  console.log("\n# diário");
  const today = spDay();
  ok((await call("POST", "/api/daily", { day: today, days: 5000, turns: 100, ending: "preso" }, tA, freshIP())).status === 422, "diário com 5000 dias rejeitado");
  ok((await call("POST", "/api/daily", { day: today, days: 300, turns: 40, ending: "lenda" }, tA, freshIP())).status === 422, "lenda com 300 dias rejeitada");
  ok((await call("POST", "/api/daily", { day: today, days: 200, turns: 2, ending: "preso" }, tA, freshIP())).status === 422, "200 dias em 2 decisões rejeitado");
  ok((await call("POST", "/api/daily", { day: "2020-01-01", days: 40, turns: 6, ending: "preso" }, tA, freshIP())).status === 409, "diário de outro dia rejeitado");
  const dOk = await call("POST", "/api/daily", { day: today, days: 41, turns: 6, ending: "preso" }, tA, freshIP());
  ok(dOk.status === 200 && dOk.data.me?.days === 41, "resultado plausível aceito", dOk.data);
  const lb = await call("GET", "/api/daily", undefined, undefined, freshIP());
  ok(lb.data.day === today && lb.data.total === 1, "GET /api/daily usa o dia de Brasília");

  console.log("\n# limites de códigos");
  const forgots: any[] = [];
  for (let i = 0; i < 6; i++) forgots.push((await call("POST", "/api/auth/forgot", { nick: "bruno_t" }, undefined, freshIP())).data);
  // bruno_t já gastou 1 envio na confirmação: 4 códigos de troca e depois resposta igual, sem código
  ok(forgots.every((f) => f.ok === true) && forgots.filter((f) => f.devCode).length === 4, "forgot: limite diário por conta, resposta sempre igual", forgots.map((f) => !!f.devCode));
  const lastCode = forgots.filter((f) => f.devCode).pop().devCode;
  for (let i = 0; i < 3; i++) await call("POST", "/api/auth/reset", { nick: "bruno_t", code: "000001", pin: "trocada48" }, undefined, freshIP());
  ok((await call("POST", "/api/auth/reset", { nick: "bruno_t", code: lastCode, pin: "123456" }, undefined, freshIP())).status === 400, "reset recusa senha fraca (sem gastar o código)");
  const rs = await call("POST", "/api/auth/reset", { nick: "bruno_t", code: lastCode, pin: "trocada48" }, undefined, freshIP());
  ok(rs.status === 200, "reset com o código certo funciona", rs.data);
  ok((await call("POST", "/api/auth/enter", { nick: "bruno_t", pin: "trocada48" }, undefined, freshIP())).status === 200, "entra com a senha trocada");

  console.log("\n# sessões");
  const s2 = await call("POST", "/api/auth/enter", { nick: "alice_t", pin: "maleta75" }, undefined, freshIP());
  ok((await call("POST", "/api/auth/logout-all", undefined, s2.data.token, freshIP())).status === 200, "sair de todos os aparelhos");
  ok((await me(tA)).status === 401 && (await me(s2.data.token)).status === 401, "todas as sessões da conta encerradas");
  const tA2 = (await call("POST", "/api/auth/enter", { nick: "alice_t", pin: "maleta75" }, undefined, freshIP())).data.token;

  console.log("\n# admin");
  const adm: number[] = [];
  for (let i = 0; i < 12; i++) adm.push((await call("GET", "/api/admin/overview", undefined, undefined, "10.200.0.1", { "x-admin-token": "errado" })).status);
  ok(adm.slice(0, 10).every((s) => s === 401) && adm[11] === 429, "rate limit no /api/admin", adm);

  console.log("\n# lockout persistente");
  const tC = await verifiedUser("carla_t", "pombo9051");
  const tries: number[] = [];
  for (let i = 0; i < 6; i++) tries.push((await call("POST", "/api/auth/enter", { nick: "carla_t", pin: "111119" }, undefined, freshIP())).status);
  ok(tries.slice(0, 5).every((s) => s === 401) && tries[5] === 429, "5 erros bloqueiam a conta", tries);
  await stopServer();
  await startServer();
  const afterRestart = await call("POST", "/api/auth/enter", { nick: "carla_t", pin: "pombo9051" }, undefined, freshIP());
  ok(afterRestart.status === 429, "bloqueio continua após reiniciar o servidor (senha certa recusada)", afterRestart.data);
  {
    await verifiedUser("dani_t", "pombo9052");
    const par = await Promise.all(Array.from({ length: 40 }, () => call("POST", "/api/auth/enter", { nick: "dani_t", pin: "111119" }, undefined, freshIP())));
    const db = new Database(join(DATA, "saldozero.sqlite"), { readonly: true });
    const u = db.query("SELECT pin_fails, locked_until FROM users WHERE nick = 'dani_t'").get() as any;
    db.close();
    ok(u.pin_fails >= 5 && u.locked_until > Date.now() && par.some((r) => r.status === 429) && !par.some((r) => r.status === 200), "tentativas em paralelo não escapam do bloqueio", u);
  }

  console.log("\n# exclusão de conta (LGPD)");
  ok((await call("DELETE", "/api/me", { pin: "000000" }, tA2, freshIP())).status === 403, "excluir com senha errada = 403 (não desloga)");
  ok((await call("DELETE", "/api/me", { pin: "maleta75" }, tA2, freshIP())).status === 200, "excluir com senha certa");
  ok((await me(tA2)).status === 401, "sessão some com a conta");
  {
    const db = new Database(join(DATA, "saldozero.sqlite"), { readonly: true });
    const u = db.query("SELECT COUNT(*) AS n FROM users WHERE nick = 'alice_t'").get() as any;
    const o = db.query("SELECT COUNT(*) AS n, SUM(user_id IS NULL) AS anon, SUM(erased) AS erased FROM orders WHERE payment_id = ?").get(pid) as any;
    const t = db.query("SELECT COUNT(*) AS n FROM results").get() as any;
    ok(u.n === 0 && o.n === 1 && o.anon === 1 && o.erased === 1 && t.n === 0, "conta e resultados apagados; pedido mantido anonimizado", { u, o, t });
    db.close();
  }
  void tC;

  console.log("\n# backup");
  await Bun.sleep(5500);
  const bdir = join(DATA, "backups");
  ok(existsSync(bdir) && readdirSync(bdir).some((f) => /^saldozero-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)), "backup diário gerado em DATA_DIR/backups");

  console.log("\n# trava DEV_CODES em produção");
  const bad = Bun.spawn(["bun", ROOT + "server.ts"], { env: { ...env, PORT: String(SRV_PORT + 1), ASAAS_ENV: "production" }, stdout: "ignore", stderr: "ignore" });
  ok((await bad.exited) === 1, "servidor recusa subir com DEV_CODES=1 e ASAAS_ENV=production");

  console.log("\n# unidade: status não regride");
  process.env.DATA_DIR = join(DATA, "unit");
  const { nextStatus } = await import("../store.ts");
  ok(nextStatus("RECEIVED", "PENDING") === "RECEIVED" && nextStatus("CONFIRMED", "OVERDUE") === "CONFIRMED", "pago não volta a pendente/vencido");
  ok(nextStatus("RECEIVED", "REFUNDED") === "REFUNDED" && nextStatus("REFUNDED", "RECEIVED") === "REFUNDED", "estorno vale e é final");
  ok(nextStatus("CHARGEBACK_REQUESTED", "RECEIVED") === "RECEIVED", "chargeback revertido volta a pago");
} catch (e) {
  failed++;
  console.error("ERRO NO TESTE", e);
} finally {
  await stopServer();
  fake.kill();
}
console.log("\n" + passed + " ok, " + failed + " falha(s)");
process.exit(failed ? 1 : 0);
