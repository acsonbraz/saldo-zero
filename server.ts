// Servidor do Saldo Zero (Bun, sem dependências).
// - Monta a página do jogo em memória a partir de game.html.
// - Serve o PWA: manifesto, service worker, ícones e fontes locais (public/).
// - Serve as páginas legais /privacidade, /suporte e /aviso.
// - Cabeçalhos de segurança (CSP com hash dos scripts inline, HSTS etc.), limites por IP e backup diário do SQLite.
import { storeEnabled, storeConfig, createCheckout, getOrder, restorePurchases, webhookAuthorized, handleWebhook, noteWebhookFailure, reconcilePayments, claimOrder, StoreError } from "./store";
import { enter, nickAvailable, logout, logoutAll, userFromRequest, requireUser, requireVerified, publicUser, entitlementsOf, mergeProgress, submitDaily, leaderboard, spendFavores, createTicket, myTickets, verifyEmail, resendVerification, setEmail, forgotPin, resetPin, deleteAccount, cleanupSessions, spDay, AuthError } from "./auth";
import { mailEnabled } from "./mail";
import { adminEnabled, adminAuthorized, overview, listOrders, listUsers, userDetail, userAction, listTickets, answerTicket } from "./admin";
import { db, backupNow } from "./db";

// ---- trava de segurança: códigos de teste nunca em produção ----
if (Bun.env.DEV_CODES === "1" && (Bun.env.ASAAS_ENV || "sandbox") === "production") {
  console.error("Recusado: DEV_CODES=1 devolve códigos de acesso na API e não pode rodar com ASAAS_ENV=production.");
  process.exit(1);
}

const root = new URL("./", import.meta.url);
const fragmentRaw = await Bun.file(new URL("./game.html", root)).text();

// Fontes locais no lugar do Google Fonts: o jogo funciona off-line e sem chamadas externas (a CSP só permite 'self').
const fontsCSS = `<style>
@font-face{font-family:'Anton';font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/Anton.woff2) format('woff2')}
@font-face{font-family:'Rubik';font-style:normal;font-weight:300 900;font-display:swap;src:url(/fonts/Rubik.woff2) format('woff2')}
@font-face{font-family:'Rubik';font-style:italic;font-weight:300 900;font-display:swap;src:url(/fonts/Rubik-Italic.woff2) format('woff2')}
</style>`;
const GF = /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/;
const fragment = GF.test(fragmentRaw) ? fragmentRaw.replace(GF, fontsCSS) : fragmentRaw.includes("/fonts/Anton.woff2") ? fragmentRaw : fontsCSS + fragmentRaw;

// Versão do cache do service worker: muda sempre que o jogo muda.
const version = new Bun.CryptoHasher("sha1").update(fragmentRaw).digest("hex").slice(0, 10);
const swSource = (await Bun.file(new URL("./public/sw.js", root)).text()).replaceAll("__VERSION__", version);

const SITE = (Bun.env.SITE_URL || "https://vorkaro.site").replace(/\/$/, "");
const SUPPORT_EMAIL = "contato@vorkaro.site";
const VENDOR = "EBENIX TECNOLOGIA INOVA SIMPLES (I.S.), CNPJ 68.730.443/0001-71";
const title = "Saldo Zero · Você é o banqueiro. Quantos dias até a PF chegar?";
const description = "Sátira ficcional de cartas: você comanda o Banco Maxter, negocia com o poder e tenta escapar da Operação Saldo Zero. Desafio diário com as mesmas cartas para todos. Quantos dias você dura?";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const head = (t: string, desc: string) => `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d1020">
<meta name="description" content="${attr(desc)}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Saldo Zero">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Saldo Zero">
<meta property="og:title" content="${attr(t)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:url" content="${SITE}/">
<meta property="og:image" content="${SITE}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(t)}">
<meta name="twitter:description" content="${attr(desc)}">
<meta name="twitter:image" content="${SITE}/og.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}</style>
`;
const swRegister = `<script>if('serviceWorker' in navigator){addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{})})}</script>`;
const html = head(title, description) + fragment + swRegister + "\n</body>\n</html>\n";
const adminPage = await Bun.file(new URL("./admin.html", root)).text();

// ---- Content-Security-Policy: scripts inline liberados só pelo hash (calculado a cada boot, então edições em
// game.html não exigem mexer aqui). Atributos de evento inline (onclick="...") NÃO funcionam com esta política.
function inlineScriptHashes(page: string) {
  const out: string[] = [];
  for (const m of page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push("'sha256-" + new Bun.CryptoHasher("sha256").update(m[1]).digest("base64") + "'");
  }
  return out;
}
function csp(page: string) {
  return [
    "default-src 'self'",
    "script-src 'self' " + inlineScriptHashes(page).join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

const legalStyle = `<style>body{margin:0;background:#0d1020;color:#f4f1ea;font:16px/1.6 -apple-system,system-ui,sans-serif}main{max-width:680px;margin:0 auto;padding:32px 20px 60px}h1{font-size:28px;line-height:1.15}h2{font-size:18px;margin-top:28px}a{color:#f5c04a}p,li{color:#d6d8e6}small{color:#9ea4c4}footer{margin-top:36px;border-top:1px solid #2c3152;padding-top:14px;font-size:13px;color:#9ea4c4}</style>`;
const vendorFooter = `<footer>Saldo Zero é oferecido por <b>${VENDOR}</b>. Contato: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. <a href="/suporte">Suporte</a> · <a href="/privacidade">Privacidade</a> · <a href="/aviso">Aviso legal</a> · <a href="/">Voltar ao jogo</a></footer>`;
const legal = (t: string, inner: string) => head(t, t + " · Saldo Zero") + `<title>${t}</title>` + legalStyle + "<main>" + inner + vendorFooter + "</main>\n</body>\n</html>\n";

const privacy = legal("Política de privacidade · Saldo Zero", `
<h1>Política de privacidade</h1>
<small>Última atualização: 19 de outubro de 2026</small>
<p><b>Saldo Zero</b> é um jogo de ficção e sátira que roda no navegador, em ${SITE.replace(/^https?:\/\//, "")}. Esta política explica quais dados pessoais tratamos, por quê, por quanto tempo e como você exerce seus direitos, conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018, LGPD).</p>

<h2>1. Quem é o controlador</h2>
<p>O controlador dos dados é <b>${VENDOR}</b>, que oferece o jogo e recebe os pagamentos das compras opcionais. Para assuntos de privacidade, inclusive como canal do encarregado, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>2. Quais dados tratamos</h2>
<ul>
<li><b>Sem conta:</b> você joga sem cadastro. Progresso, finais, conquistas e preferências ficam no armazenamento local do seu navegador. Não usamos cookies.</li>
<li><b>Conta de jogo (opcional):</b> <b>apelido</b> (público no ranking), <b>PIN</b> guardado apenas como hash criptográfico (não temos como lê-lo), <b>e-mail</b> (opcional; serve para confirmar a conta, recuperar o PIN e avisos de segurança; nunca é exibido nem usado para marketing), progresso (finais, conquistas, coleção, recorde), resultados do desafio diário, saldo de favores e itens adquiridos. Para manter você conectado, o navegador guarda um token de sessão; no servidor fica só o hash desse token, com as datas de criação e de último uso.</li>
<li><b>Compras (opcionais):</b> para emitir a cobrança, o formulário pede nome, e-mail e CPF ou CNPJ. Esses dados são enviados ao <b>Asaas</b>, que processa o pagamento (Pix, cartão ou boleto). <b>Não guardamos o CPF/CNPJ</b> no nosso banco de dados nem no seu navegador; ele é informado de novo quando você restaura compras. Guardamos o identificador da cobrança, o produto, o valor, o status, as datas e a conta de jogo ligada à compra. Dados de cartão são digitados na página do Asaas e não chegam até nós.</li>
<li><b>Suporte:</b> chamados abertos no menu Ajuda guardam o apelido (ou o e-mail informado para resposta), o assunto, a mensagem e a nossa resposta.</li>
<li><b>Registros técnicos:</b> endereço IP e dados da requisição, usados por pouco tempo para segurança (limite de tentativas, prevenção de abuso) e mantidos pela hospedagem por prazo limitado.</li>
</ul>

<h2>3. Para que e com qual base legal</h2>
<ul>
<li><b>Execução de contrato</b> (LGPD, art. 7º, V): criar e manter a conta, guardar progresso e compras, ranking diário, entregar os itens comprados, recuperar o PIN e responder chamados.</li>
<li><b>Cumprimento de obrigação legal</b> (art. 7º, II): manter os registros de pagamento exigidos pela legislação fiscal e contábil.</li>
<li><b>Legítimo interesse</b> (art. 7º, IX): segurança do serviço, prevenção de fraude e de abuso (por exemplo, bloqueio após tentativas erradas de PIN).</li>
</ul>

<h2>4. Com quem compartilhamos</h2>
<p>Somente com os operadores necessários ao serviço: <b>Asaas</b> (pagamentos), <b>Resend</b> (envio dos e-mails de código e aviso) e o provedor de hospedagem do servidor. Alguns desses provedores podem tratar dados fora do Brasil, nas hipóteses do art. 33 da LGPD. Não vendemos dados, não exibimos anúncios e não usamos ferramentas de rastreamento de terceiros. Ao tocar em "Compartilhar" ou "Copiar resultado", o texto vai para o aplicativo que você escolher; nada é publicado automaticamente.</p>

<h2>5. Por quanto tempo guardamos</h2>
<ul>
<li>Conta, progresso, resultados e chamados: enquanto a conta existir. Ao excluir a conta, apagamos tudo isso na hora.</li>
<li>Sessões: expiram após 30 dias sem uso ou 90 dias desde o login, o que vier primeiro.</li>
<li>Registros de pagamento: pelo prazo exigido pela legislação fiscal (em regra, 5 anos). Depois da exclusão da conta, ficam <b>sem vínculo com a sua conta</b> (apenas identificador da cobrança, produto, valor, status e datas).</li>
<li>Cópias de segurança do banco: diárias, guardadas por 7 dias; dados excluídos somem delas nesse prazo.</li>
</ul>

<h2>6. Seus direitos</h2>
<p>Você pode pedir confirmação e acesso aos dados, correção, anonimização, bloqueio ou eliminação, portabilidade, informação sobre com quem compartilhamos e se opor a tratamentos (LGPD, art. 18). Para <b>excluir a conta</b> e os dados ligados a ela, use "Excluir minha conta" no painel da conta, na tela inicial do jogo (pedimos o PIN para confirmar). Para os demais pedidos, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> a partir do e-mail cadastrado ou informando o apelido. <b>Nunca peça nem envie o seu PIN por e-mail</b>: não precisamos dele. Você também pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).</p>

<h2>7. Crianças e adolescentes</h2>
<p>O jogo é recomendado para maiores de 12 anos e não se destina a crianças. Adolescentes devem jogar com o conhecimento dos pais ou responsáveis, e as compras são pagas por um adulto, titular do CPF informado na cobrança. Tratamos dados de adolescentes no seu melhor interesse (LGPD, art. 14) e apenas os listados acima. Se identificarmos uma conta de criança, ela será excluída; responsáveis podem pedir a exclusão pelo e-mail acima.</p>

<h2>8. Segurança</h2>
<p>Conexão sempre por HTTPS, PIN e tokens de sessão guardados apenas como hash, bloqueio progressivo após tentativas erradas e acesso administrativo protegido. Nenhum sistema é infalível; se notarmos um incidente que possa trazer risco relevante, avisaremos os titulares afetados e a ANPD.</p>

<h2>9. Mudanças</h2>
<p>Quando esta política mudar, a data no topo será atualizada e mudanças relevantes serão avisadas no jogo.</p>
`);

const support = legal("Suporte · Saldo Zero", `
<h1>Suporte</h1>
<p><b>Saldo Zero</b> é uma obra de ficção e sátira. Personagens, bancos, veículos de imprensa e instituições são inventados; qualquer semelhança com a realidade é parte da brincadeira, não uma afirmação sobre pessoas reais.</p>
<h2>Perguntas frequentes</h2>
<p><b>Preciso de conta?</b> Não para jogar. Com um apelido e um PIN você entra no ranking diário e guarda compras e conquistas em qualquer aparelho.</p>
<p><b>Esqueci o PIN.</b> Na tela inicial, digite o apelido e toque em "Esqueci o PIN": enviamos um código para o e-mail confirmado da conta. <b>Nunca pedimos o PIN por e-mail nem por mensagem</b> e você nunca deve enviá-lo a ninguém. Se a conta não tem e-mail, abra um chamado pelo menu Ajuda dentro do jogo.</p>
<p><b>O que são favores?</b> A moeda das jogadas do Vorkaro (ações por iniciativa própria) e dos recursos para continuar uma partida no modo livre. Toda partida começa com 2; pacotes extras ficam na conta. No desafio diário todo mundo tem os mesmos 2 e não há recurso.</p>
<p><b>Comprei e não liberou.</b> O item aparece na conta assim que o Asaas confirma o pagamento (Pix leva segundos; boleto, até 2 dias úteis). Se não aparecer, abra um chamado no menu Ajuda com o apelido usado na compra.</p>
<p><b>Como instalo no celular?</b> No Safari (iPhone), toque em Compartilhar e depois em "Adicionar à Tela de Início". No Chrome (Android), toque no menu e em "Instalar app". O jogo passa a abrir em tela cheia e funciona sem internet.</p>
<p><b>O desafio diário muda de aparelho para aparelho?</b> Não. Todo mundo recebe a mesma sequência de cartas no mesmo dia (horário de Brasília).</p>
<p><b>Perdi meu progresso.</b> Sem conta, o progresso fica só no navegador: limpar os dados do site apaga finais e conquistas. Com conta, entre de novo com o apelido e o PIN para recuperá-lo.</p>
<p><b>Como excluo minha conta?</b> No painel da conta, na tela inicial, use "Excluir minha conta". Detalhes na <a href="/privacidade">política de privacidade</a>.</p>
<h2>Fale com a gente</h2>
<p>Pelo menu Ajuda dentro do jogo ou pelo e-mail <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
`);

const legalNotice = legal("Aviso legal e de conteúdo · Saldo Zero", `
<h1>Aviso legal e de conteúdo</h1>
<p><b>1. Obra de ficção e sátira.</b> Saldo Zero é um jogo de humor e crítica social em forma de sátira. Todos os personagens, nomes, empresas, bancos, veículos de imprensa, partidos, instituições, diálogos e situações são fictícios e foram criados exclusivamente para entretenimento.</p>
<p><b>2. Inspiração em temas de interesse público.</b> A sátira dialoga, de forma caricatural e exagerada, com temas de interesse público amplamente noticiados pela imprensa. Isso não significa que o jogo narre fatos reais nem que descreva a conduta de qualquer pessoa, empresa ou instituição real. Eventual semelhança de nomes é recurso de paródia, não identificação.</p>
<p><b>3. Nenhum juízo de valor ou acusação.</b> O jogo não afirma, sugere nem insinua que qualquer pessoa, empresa ou instituição real tenha praticado os atos retratados. As "escolhas" e seus efeitos são mecânicas de jogo, sem relação com fatos; não expressam opinião do desenvolvedor sobre pessoas reais nem constituem aconselhamento de qualquer natureza.</p>
<p><b>4. Sem vínculo.</b> Não há vínculo, patrocínio, endosso ou autorização de qualquer pessoa, empresa, partido ou órgão público eventualmente evocado pela paródia.</p>
<p><b>5. Fundamento.</b> A obra se ampara na liberdade de expressão, de manifestação artística e de humor (Constituição Federal, art. 5º, incisos IV e IX, e art. 220) e na proteção às paródias (Lei nº 9.610/1998, art. 47).</p>
<p><b>6. Uso por sua conta.</b> O jogo não oferece orientação financeira, jurídica ou política. Compras opcionais são regidas pelas condições informadas na loja e pela <a href="/privacidade">política de privacidade</a>.</p>
<p><b>7. Público.</b> Conteúdo recomendado para maiores de 12 anos, por tratar de política e corrupção em tom de humor.</p>
<p><b>8. Contato.</b> Se você entende que algum conteúdo o atinge indevidamente, escreva para <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Analisaremos com boa-fé e rapidez.</p>
`);

const pages = {
  game: { body: html, csp: csp(html) },
  admin: { body: adminPage, csp: csp(adminPage) },
  privacy: { body: privacy, csp: csp(privacy) },
  support: { body: support, csp: csp(support) },
  legal: { body: legalNotice, csp: csp(legalNotice) },
};

const MIME: Record<string, string> = {
  png: "image/png", webmanifest: "application/manifest+json", woff2: "font/woff2", js: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", css: "text/css; charset=utf-8", webp: "image/webp", jpg: "image/jpeg", mp4: "video/mp4", webm: "video/webm",
};
const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

// ---- IP do cliente ----
// No Railway, o proxy de borda grava o IP de quem conectou em X-Real-IP (sobrescreve o que o cliente mandar) e
// acrescenta esse mesmo IP ao fim de X-Forwarded-For. Por isso: X-Real-IP; se faltar, o ÚLTIMO item de
// X-Forwarded-For (o primeiro é controlado pelo cliente). Fora do Railway (sem RAILWAY_ENVIRONMENT nem
// TRUST_PROXY=1) os cabeçalhos são ignorados e vale o IP da conexão.
const TRUST_PROXY = !!(Bun.env.RAILWAY_ENVIRONMENT || Bun.env.RAILWAY_ENVIRONMENT_NAME || Bun.env.TRUST_PROXY === "1");
function clientIP(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
  if (TRUST_PROXY) {
    const real = req.headers.get("x-real-ip")?.trim();
    if (real) return real;
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",").pop()!.trim();
  }
  return server.requestIP(req)?.address || "local";
}

// ---- limites ----
// Por IP e por "balde", janela de 1 minuto. O mapa é limpo a cada minuto (sem crescer para sempre).
const hits = new Map<string, { n: number; t: number }>();
function limited(ip: string, max = 30, bucket = "api") {
  const key = ip + ":" + bucket;
  const t = Date.now();
  const h = hits.get(key);
  if (!h || t - h.t > 60_000) { hits.set(key, { n: 1, t }); return false; }
  h.n++;
  return h.n > max;
}
// Limite global (todas as origens somadas) para as rotas de PIN: freia força bruta distribuída por muitos IPs.
const GLOBAL_AUTH_PER_MIN = Number(Bun.env.GLOBAL_AUTH_PER_MIN || 600);
let globalAuth = { n: 0, t: 0 };
function globalAuthLimited() {
  const t = Date.now();
  if (t - globalAuth.t > 60_000) globalAuth = { n: 0, t };
  return ++globalAuth.n > GLOBAL_AUTH_PER_MIN;
}
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.t > 60_000) hits.delete(k); }, 60_000).unref?.();

async function api(req: Request, pathname: string, ip: string): Promise<Response | null> {
  try {
    if (pathname === "/api/store/config") return json({ ...storeConfig(), mail: mailEnabled });

    // ---- conta de jogo ----
    if (req.method === "GET" && pathname === "/api/auth/check") {
      if (limited(ip, 60, "check")) return json({ error: "Muitas consultas. Aguarde um minuto." }, 429);
      const nick = new URL(req.url).searchParams.get("nick");
      return json(nickAvailable(nick));
    }
    if (req.method === "POST" && pathname === "/api/auth/enter") {
      if (limited(ip, 20, "auth") || globalAuthLimited()) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      const body = await req.json();
      const result = await enter(body);
      if (typeof body?.claim === "string" && body.claim.startsWith("sz:")) claimOrder(body.claim, result.user.id);
      return json({ ...result, entitlements: entitlementsOf(result.user.id) });
    }
    if (req.method === "POST" && pathname === "/api/auth/logout") { logout(req); return json({ ok: true }); }
    if (req.method === "POST" && pathname === "/api/auth/logout-all") return json(logoutAll(requireUser(req)));
    if (req.method === "POST" && pathname === "/api/auth/verify") {
      if (limited(ip, 10, "code")) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      return json(await verifyEmail(requireUser(req), await req.json()));
    }
    if (req.method === "POST" && pathname === "/api/auth/resend") {
      if (limited(ip, 5, "mail")) return json({ error: "Aguarde um minuto para pedir outro código." }, 429);
      return json(await resendVerification(requireUser(req)));
    }
    if (req.method === "POST" && pathname === "/api/auth/email") {
      if (limited(ip, 5, "mail")) return json({ error: "Aguarde um minuto para tentar de novo." }, 429);
      return json(await setEmail(requireUser(req), await req.json()));
    }
    if (req.method === "POST" && pathname === "/api/auth/forgot") {
      if (limited(ip, 5, "mail")) return json({ error: "Aguarde um minuto para pedir outro código." }, 429);
      return json(await forgotPin(await req.json()));
    }
    if (req.method === "POST" && pathname === "/api/auth/reset") {
      if (limited(ip, 10, "code") || globalAuthLimited()) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      return json(await resetPin(await req.json()));
    }
    if (req.method === "GET" && pathname === "/api/me") {
      const u = requireUser(req);
      return json({ user: publicUser(u), entitlements: entitlementsOf(u.id) });
    }
    if (req.method === "DELETE" && pathname === "/api/me") {
      if (limited(ip, 5, "delete")) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      return json(await deleteAccount(requireUser(req), await req.json().catch(() => ({}))));
    }
    if (req.method === "POST" && pathname === "/api/favores/spend") {
      const u = requireUser(req);
      return json({ favores: spendFavores(u, (await req.json())?.n) });
    }
    if (req.method === "PUT" && pathname === "/api/me/progress") {
      const u = requireUser(req);
      return json({ progress: mergeProgress(u, await req.json()) });
    }
    if (req.method === "POST" && pathname === "/api/daily") {
      const u = requireUser(req);
      return json(submitDaily(u, await req.json()));
    }
    if (req.method === "GET" && pathname === "/api/daily") {
      const day = new URL(req.url).searchParams.get("day") || spDay();
      return json(leaderboard(day, userFromRequest(req)?.id));
    }

    // ---- suporte ----
    if (req.method === "POST" && pathname === "/api/support") {
      if (limited(ip, 5, "support")) return json({ error: "Muitos chamados em pouco tempo. Aguarde um minuto." }, 429);
      return json(createTicket(userFromRequest(req), await req.json()));
    }
    if (req.method === "GET" && pathname === "/api/support") return json({ tickets: myTickets(requireUser(req)) });

    // ---- painel do desenvolvedor ----
    if (pathname.startsWith("/api/admin/")) {
      if (limited(ip, 120, "admin")) return json({ error: "Muitas requisições. Aguarde um minuto." }, 429);
      if (!adminAuthorized(req)) {
        if (limited(ip, 10, "admin-fail")) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
        return json({ error: adminEnabled ? "Token inválido." : "Painel desligado: defina ADMIN_TOKEN." }, 401);
      }
      const url = new URL(req.url);
      if (pathname === "/api/admin/overview") return json(overview());
      if (pathname === "/api/admin/orders") return json({ orders: listOrders() });
      if (pathname === "/api/admin/users" && req.method === "GET") return json(listUsers(url.searchParams.get("q") || "", Number(url.searchParams.get("page") || 1)));
      const um = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
      if (um && req.method === "GET") return json(userDetail(Number(um[1])));
      if (um && req.method === "POST") return json(await userAction(Number(um[1]), await req.json()));
      if (pathname === "/api/admin/tickets" && req.method === "GET") return json({ tickets: listTickets(url.searchParams.get("status") || "") });
      const tm = pathname.match(/^\/api\/admin\/tickets\/(\d+)$/);
      if (tm && req.method === "POST") return json(answerTicket(Number(tm[1]), await req.json()));
      return json({ error: "Rota não encontrada." }, 404);
    }

    // ---- webhook do Asaas: sempre 200 depois do token (o Asaas pausa a fila em respostas de erro) ----
    if (req.method === "POST" && pathname === "/api/webhook/asaas") {
      if (!webhookAuthorized(req)) { console.warn("[asaas webhook] token inválido de " + ip); return json({ error: "token inválido" }, 401); }
      const event = await req.json().catch(() => ({}));
      try { await handleWebhook(event); }
      catch (e) {
        console.error("[asaas webhook] erro ao processar " + (event?.event || "?") + " " + (event?.payment?.id || "?") + ": " + (e as Error).message);
        try { noteWebhookFailure(String(event?.payment?.id || ""), String(event?.event || "")); } catch {}
      }
      return json({ received: true });
    }

    // ---- loja ----
    if (!storeEnabled) return pathname.startsWith("/api/") ? json({ error: "Loja desligada." }, 503) : null;
    if (req.method === "POST" && pathname === "/api/checkout") {
      if (limited(ip, 30, "checkout")) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      const u = userFromRequest(req);
      if (!u) return json({ error: "Entre com seu apelido antes de comprar: a compra fica guardada na sua conta." }, 401);
      requireVerified(u);
      return json(await createCheckout(await req.json(), SITE, u.id));
    }
    if (req.method === "GET" && pathname.startsWith("/api/order/")) {
      if (limited(ip, 60, "order")) return json({ error: "Muitas tentativas." }, 429);
      const u = requireUser(req);
      return json(await getOrder(decodeURIComponent(pathname.slice("/api/order/".length)), u.id));
    }
    if (req.method === "POST" && pathname === "/api/restore") {
      if (limited(ip, 10, "restore")) return json({ error: "Muitas tentativas. Aguarde um minuto." }, 429);
      const u = requireUser(req);
      return json(await restorePurchases(await req.json(), u.id));
    }
    if (pathname.startsWith("/api/")) return json({ error: "Rota não encontrada." }, 404);
  } catch (e) {
    if (e instanceof StoreError || e instanceof AuthError) return json({ error: e.message }, e.status);
    if (e instanceof SyntaxError) return json({ error: "Requisição inválida." }, 400);
    console.error("[api]", e);
    return json({ error: "Falha temporária no servidor. Tente de novo em instantes." }, 502);
  }
  return null;
}

function withSecurity(res: Response, cspValue = API_CSP) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  if (!res.headers.has("content-security-policy")) res.headers.set("content-security-policy", cspValue);
  return res;
}
const page = (p: { body: string; csp: string }, extra: Record<string, string> = {}) =>
  new Response(p.body, { headers: { ...htmlHeaders, "content-security-policy": p.csp, ...extra } });

const server = Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  async fetch(req, srv) {
    return withSecurity(await route(req, clientIP(req, srv)));
  },
});

async function route(req: Request, ip: string): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") {
    try { db.query("SELECT 1").get(); return new Response("ok", { headers: { "cache-control": "no-store" } }); }
    catch { return new Response("db indisponível", { status: 503 }); }
  }
  if (pathname.startsWith("/api/")) return (await api(req, pathname, ip)) || json({ error: "Rota não encontrada." }, 404);
  if (pathname === "/privacidade" || pathname === "/privacy") return page(pages.privacy);
  if (pathname === "/suporte" || pathname === "/support") return page(pages.support);
  if (pathname === "/aviso" || pathname === "/legal") return page(pages.legal);
  if (pathname === "/admin") return page(pages.admin, { "x-robots-tag": "noindex", "referrer-policy": "no-referrer" });
  if (pathname === "/sw.js") return new Response(swSource, { headers: { "content-type": MIME.js, "cache-control": "no-cache", "service-worker-allowed": "/" } });

  // Arquivos estáticos de public/ (manifesto, ícones, fontes, imagem de preview). Nomes sem hash: cache de 1 dia
  // (fontes, 7 dias), sem "immutable", para que uma troca de arquivo chegue a todos.
  const safe = pathname.replace(/\.\./g, "");
  const ext = safe.split(".").pop() || "";
  if (safe.length > 1 && MIME[ext]) {
    const file = Bun.file(new URL("./public" + safe, root));
    if (await file.exists()) {
      const cache = ext === "webmanifest" ? "no-cache" : ext === "woff2" ? "public, max-age=604800" : "public, max-age=86400";
      return new Response(file, { headers: { "content-type": MIME[ext], "cache-control": cache } });
    }
    return new Response("not found", { status: 404 });
  }
  return page(pages.game);
}

// ---- rotinas ----
const HOUR = 3600_000;
setInterval(() => { try { const n = cleanupSessions(); if (n) console.log("[sessões] expiradas removidas: " + n); } catch (e) { console.error("[sessões]", e); } }, HOUR).unref?.();
if (storeEnabled) {
  const reconcile = () => reconcilePayments().catch((e) => console.error("[conciliação]", e));
  setTimeout(reconcile, Number(Bun.env.RECONCILE_FIRST_MS || 60_000)).unref?.();
  setInterval(reconcile, HOUR).unref?.();
}
if (Bun.env.BACKUP_DISABLED !== "1") {
  setTimeout(backupNow, 5_000).unref?.();            // logo após subir
  setInterval(backupNow, HOUR).unref?.();             // gera no máximo 1 por dia (pula se o do dia já existe)
}

let closing = false;
function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  console.log("[" + sig + "] encerrando: parando o servidor e fechando o banco");
  try { server.stop(); } catch {}
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); } catch (e) { console.error("[shutdown]", e); }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("Saldo Zero rodando na porta " + server.port + " (cache " + version + ", loja " + (storeEnabled ? "Asaas " + (Bun.env.ASAAS_ENV || "sandbox") : "desligada") + ", e-mail " + (mailEnabled ? "Resend" : "desligado") + ", site " + SITE + ", proxy " + (TRUST_PROXY ? "confiável (X-Real-IP)" : "não") + ")");
