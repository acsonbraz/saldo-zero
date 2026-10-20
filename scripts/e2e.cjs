// Teste ponta a ponta no navegador (Playwright): login em etapas (diálogo), loja com Asaas falso + webhook, itens
// vindos do servidor, ranking diário, intro (com fixtures), áudio, retomada de partida com a mesma sequência de cartas
// e ausência de violações de CSP.
// Pré-requisitos (rodando):
//   FAKE_PORT=3131 FAKE_WEBHOOK_URL=http://127.0.0.1:3125/api/webhook/asaas FAKE_WEBHOOK_TOKEN=tok-de-teste-1234 bun scripts/fake-asaas.ts
//   DATA_DIR=/tmp/sz-e2e DEV_CODES=1 ASAAS_API_KEY=test ASAAS_BASE_URL=http://127.0.0.1:3131/v3 ASAAS_WEBHOOK_TOKEN=tok-de-teste-1234 SITE_URL=http://127.0.0.1:3125 PORT=3125 bun server.ts
// Playwright: PW_PATH=/caminho/node_modules/playwright node scripts/e2e.cjs (padrão: require('playwright')).
// A intro e o áudio reais (public/intro, public/audio) não são necessários: os contextos marcados com fixtures servem
// scripts/fixtures/intro e scripts/fixtures/audio via page.route; nos demais, /intro/intro.json dá 404 e o jogo começa direto.
const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:3125';
const FIX = path.join(__dirname, 'fixtures');
let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log('  ✓ ' + name); else { failures++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const acceptLegal = async (page) => { await page.waitForTimeout(150); if (await page.isVisible('#legalScreen')) { await page.click('#legalOk'); await page.waitForTimeout(200); } };
const PW = 'tucano42', PW_B = 'jatinho77', PW_NEW = 'charuto90', PW_C = 'maleta55';
const step = (p) => p.evaluate(() => AUTH.step);
const waitStep = (p, name) => p.waitForFunction((n) => AUTH.step === n, name, { timeout: 5000 });
/* Contextos sem fixtures: a intro real existe em public/intro, então aqui ela é tirada (404) para o jogo começar direto. */
async function plainCtx(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await ctx.route('**/intro/intro.json', (r) => r.fulfill({ status: 404, body: '' }));
  return ctx;
}
/* Fixtures da intro e do áudio (o service worker é bloqueado no contexto para o page.route enxergar tudo). */
async function fixtureContext(browser, extra = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }, extra));
  await ctx.route('**/intro/*', (r) => { const f = path.join(FIX, 'intro', path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ path: f, contentType: f.endsWith('.json') ? 'application/json' : 'image/svg+xml' }) : r.fulfill({ status: 404, body: '' }); });
  await ctx.route('**/audio/*', (r) => { const f = path.join(FIX, 'audio', path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ path: f, contentType: 'audio/mpeg' }) : r.fulfill({ status: 404, body: '' }); });
  return ctx;
}
/* Diálogo já aberto: apelido -> (senha nova + e-mail opcional | senha) -> passo "ready". */
async function authFlow(p, { nick, pw, email, create }) {
  await p.fill('#aNick', nick); await p.click('#aSubmit');
  await waitStep(p, create ? 'new' : 'login');
  await p.fill('#aPass', pw); await p.click('#aSubmit');
  if (create) {
    await waitStep(p, 'email');
    if (email) { await p.fill('#aEmail', email); await p.click('#aSubmit'); } else await p.click('#aSkip');
  }
  await p.waitForFunction(() => AUTH.step === 'ready' || !document.getElementById('authDlg').open, null, { timeout: 5000 });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await plainCtx(browser);
  const page = await ctx.newPage();
  const errors = [];
  const watch = (p) => { p.on('pageerror', e => errors.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of (400|401|403|404|409|422|429)/.test(m.text())) errors.push('console: ' + m.text()); }); };
  watch(page);

  await page.goto(BASE + '/'); await page.waitForTimeout(800);
  check('loja visível', await page.isVisible('#openShop'));
  check('rodapé sem "Nenhuma cobrança real"', !(await page.textContent('#legalNote')).includes('Nenhuma cobrança real'));
  check('data do jogo em 2026', (await page.textContent('#date')).includes('2026'));
  check('tela inicial sem formulário grande: só o botão Entrar', await page.isVisible('#loginOpen') && (await page.$('#nickInput')) === null && (await page.$('#pinInput')) === null);

  // 1. diálogo: Esc fecha; criar conta com regras de senha ao vivo
  await page.click('#loginOpen');
  check('diálogo abre como modal com título', await page.evaluate(() => document.getElementById('authDlg').open && document.getElementById('authDlg').getAttribute('aria-labelledby') === 'authTitle') && (await page.textContent('#authTitle')).includes('apelido'));
  check('foco vai para o apelido', await page.evaluate(() => document.activeElement && document.activeElement.id === 'aNick'));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  check('Esc fecha o diálogo', !(await page.evaluate(() => document.getElementById('authDlg').open)));
  await page.click('#loginOpen');
  await page.fill('#aNick', 'a b'); await page.click('#aSubmit'); await page.waitForTimeout(200);
  check('apelido inválido mostra erro', (await page.textContent('#aErr')).includes('3 a 16'));
  const nick = 'tester_' + Math.random().toString(36).slice(2, 7);
  await page.fill('#aNick', nick); await page.click('#aSubmit'); await waitStep(page, 'new');
  check('apelido novo pede "Escolha uma senha"', (await page.textContent('#authTitle')).includes('senha') && await page.isVisible('#aRules'));
  await page.fill('#aPass', 'abc');
  const r1 = await page.$$eval('#aRules li', (l) => l.map((x) => x.className));
  check('regras ao vivo: "abc" não atende tamanho nem letras+números', !r1[0].includes('ok') && !r1[1].includes('ok'), r1);
  await page.fill('#aPass', 'tucano42');
  const r2 = await page.$$eval('#aRules li', (l) => l.map((x) => x.className));
  check('regras ao vivo: senha forte atende as três', r2.every((c) => c.includes('ok')), r2);
  await page.click('#aPassShow');
  check('mostrar/ocultar senha', (await page.getAttribute('#aPass', 'type')) === 'text' && (await page.getAttribute('#aPassShow', 'aria-pressed')) === 'true');
  await page.fill('#aPass', 'abc123'); await page.click('#aSubmit'); await page.waitForTimeout(250);
  check('senha óbvia recusada (abc123)', (await step(page)) === 'new' && (await page.textContent('#aErr')).length > 0);
  await page.fill('#aPass', '2719'); await page.click('#aSubmit'); await page.waitForTimeout(250);
  check('PIN de 4 números recusado no cadastro', (await step(page)) === 'new');
  await page.fill('#aPass', PW); await page.click('#aSubmit'); await waitStep(page, 'email');
  check('conta criada: passo do e-mail com "pular por agora"', await page.isVisible('#aSkip') && (await page.textContent('#authTitle')).includes('e-mail'));
  await page.fill('#aEmail', nick + '@exemplo.com'); await page.click('#aSubmit'); await waitStep(page, 'ready');
  check('intenção "Entrar": último botão é Fechar', (await page.textContent('#aSubmit')).trim() === 'Fechar');
  await page.click('#aSubmit'); await page.waitForTimeout(400);
  check('conta criada e logada', (await page.textContent('#accountInfo')).includes('@' + nick));
  check('botões de sair de todos e excluir conta', await page.isVisible('#logoutAllBtn') && await page.isVisible('#deleteAcctBtn'));
  // compra antes de confirmar deve ser recusada
  await page.click('#openShop'); await page.waitForTimeout(300); await page.click('#shopList .buy[data-id="com.saldozero.favores10"]'); await page.waitForTimeout(200);
  await page.fill('#payName', 'Danilo Testador'); await page.fill('#payEmail', 'danilo@example.com'); await page.fill('#payCpf', '529.982.247-25'); await page.click('#payForm button[type=submit]'); await page.waitForTimeout(500);
  check('compra exige e-mail confirmado', (await page.textContent('#payError')).includes('Confirme')); await page.click('#btnShopClose');
  check('CPF não fica no localStorage', !(await page.evaluate(() => JSON.stringify(localStorage))).includes('52998224725') && !(await page.evaluate(() => JSON.stringify(localStorage))).includes('529.982'));
  const code = await page.evaluate(() => window.__devCode);
  await page.fill('#verifyCode', code); await page.click('#verifyBtn'); await page.waitForTimeout(800);
  check('e-mail confirmado', (await page.textContent('#accountInfo')).includes('confirmado'));

  // 2. apelido existente com senha errada
  const ctx2 = await plainCtx(browser);
  const p2 = await ctx2.newPage(); watch(p2); await p2.goto(BASE + '/'); await p2.waitForTimeout(600);
  await p2.click('#loginOpen'); await p2.fill('#aNick', nick); await p2.click('#aSubmit'); await waitStep(p2, 'login');
  check('apelido existente pede "Digite sua senha" e mostra "Esqueci a senha"', (await p2.textContent('#authTitle')).includes('senha') && await p2.isVisible('#aForgot') && !(await p2.isVisible('#aRules')));
  await p2.fill('#aPass', 'errada99'); await p2.click('#aSubmit'); await p2.waitForTimeout(600);
  check('senha errada recusada', (await p2.textContent('#aErr')).includes('Senha incorreta'));
  await p2.click('#authClose');

  // 3. compra pelo Asaas falso (webhook libera)
  await page.click('#openShop'); await page.waitForTimeout(300);
  await page.click('#shopList .buy[data-id="com.saldozero.favores10"]'); await page.waitForTimeout(200);
  check('CPF não é preenchido de memória', (await page.inputValue('#payCpf')) === '');
  await page.fill('#payName', 'Danilo Testador'); await page.fill('#payEmail', 'danilo@example.com'); await page.fill('#payCpf', '529.982.247-25');
  await page.click('#payForm button[type=submit]');
  await page.waitForURL(/\/pay\//, { timeout: 8000 }); await page.click('#pix');
  await page.waitForURL(u => !/\/pay\//.test(String(u)), { timeout: 8000 }); await page.waitForTimeout(2000);
  check('favores creditados após confirmação do servidor', (await page.evaluate(() => favores)) === 10, await page.evaluate(() => favores));
  check('pendente limpo após confirmação', (await page.evaluate(() => localStorage.getItem('me2:pending'))) === 'null');
  for (const id of ['com.saldozero.deck.eleicao', 'com.saldozero.vip']) {
    await page.click('#shopList .buy[data-id="' + id + '"]'); await page.waitForTimeout(200);
    await page.fill('#payCpf', '529.982.247-25');
    await page.click('#payForm button[type=submit]'); await page.waitForURL(/\/pay\//, { timeout: 8000 }); await page.click('#pix');
    await page.waitForURL(u => !/\/pay\//.test(String(u)), { timeout: 8000 }); await page.waitForTimeout(2000);
  }
  check('baralho e VIP liberados', await page.evaluate(() => owns('com.saldozero.deck.eleicao') && isVip()));
  await page.click('#btnShopClose');

  // 4. localStorage editado não libera nada: sem login o cache é descartado
  const ctx3 = await plainCtx(browser);
  const p3 = await ctx3.newPage(); watch(p3); await p3.goto(BASE + '/'); await p3.waitForTimeout(400);
  await p3.evaluate(() => localStorage.setItem('me2:ent', JSON.stringify(['com.saldozero.vip', 'com.saldozero.capas'])));
  await p3.reload(); await p3.waitForTimeout(800);
  check('VIP forjado no localStorage não vale', !(await p3.evaluate(() => isVip())));
  // conta nova com o CPF da outra pessoa não restaura nada
  await p3.click('#loginOpen'); await authFlow(p3, { nick: nick + 'b', pw: PW_B, create: true }); await p3.click('#aSubmit'); await p3.waitForTimeout(500);
  await p3.click('#openShop'); await p3.waitForTimeout(300); await p3.click('#btnRestore'); await p3.fill('#restoreCpf', '529.982.247-25'); await p3.click('#restoreForm button[type=submit]'); await p3.waitForTimeout(1000);
  check('restaurar com CPF de terceiro não libera', !(await p3.evaluate(() => isVip())) && (await p3.evaluate(() => favores)) === 0);
  await ctx3.close();

  // 5. outro navegador, senha certa: compras vêm do servidor
  await p2.click('#loginOpen'); await authFlow(p2, { nick, pw: PW }); await p2.waitForTimeout(1000);
  check('itens vêm do servidor no login', (await p2.evaluate(() => [...ent].sort().join(','))) === 'com.saldozero.deck.eleicao,com.saldozero.vip');

  // 5b. jogar sem conta: "Modo livre" abre o diálogo; apelido existente -> senha -> Jogar! -> carta
  {
    const c6 = await plainCtx(browser); const p6 = await c6.newPage(); watch(p6);
    await p6.goto(BASE + '/'); await p6.waitForTimeout(500);
    await p6.click('#playFree'); await p6.waitForTimeout(200);
    check('jogar sem conta abre o diálogo (sem iniciar partida)', await p6.evaluate(() => document.getElementById('authDlg').open && !s));
    await authFlow(p6, { nick, pw: PW });
    check('login de apelido existente termina em "Jogar!"', (await p6.textContent('#aSubmit')).trim() === 'Jogar!');
    await p6.click('#aSubmit'); await acceptLegal(p6); await p6.waitForTimeout(800);
    check('modo livre começa depois do login (intro ausente = direto ao jogo)', await p6.evaluate(() => !!s && s.mode === 'free' && !!s.card) && await p6.isVisible('#card'));
    await c6.close();
  }

  // 6. diário: mesmo VIP tem só 2 favores; termina e aparece no ranking; compartilhamento
  await page.click('#playDaily'); await acceptLegal(page); await page.waitForTimeout(500);
  if (await page.isVisible('#tut')) await page.click('#tutOk');
  check('diário: VIP também começa com 2 favores', (await page.evaluate(() => s.favores)) === 2);
  let t = 0; while (!(await page.isVisible('#endScreen')) && t < 150) { await page.click('#btnR'); await page.waitForTimeout(260); t++; }
  await page.waitForTimeout(1500);
  check('ranking de hoje no fim', (await page.textContent('#endAch')).includes('Ranking de hoje'));
  const share = await page.textContent('#shareText');
  check('texto de compartilhamento', /Durei \d+ dias\. Quantos você dura\?/.test(share) && share.includes('% dos jogadores') && share.includes(BASE + '/'), share);
  await page.click('#btnHome'); await page.waitForTimeout(1200);
  check('ranking lista o apelido', (await page.textContent('#rankList')).includes('@' + nick));

  // 7. fluxo completo do diálogo pelo "Jogar o diário" (apelido novo -> senha -> pular e-mail -> Jogar! -> intro -> carta),
  //    com intro e áudio de fixture; depois, retomar partida mantém a mesma sequência de cartas (diário)
  const seq = async (p, n) => { const ids = []; for (let i = 0; i < n; i++) { const prev = await p.evaluate(() => s.card + ":" + s.turn); ids.push(prev.split(":")[0]); await p.click("#btnR"); await p.waitForFunction((pv) => s.over || (s.card + ":" + s.turn) !== pv, prev); await p.waitForTimeout(450); if (await p.isVisible('#endScreen')) break; } return ids; };
  const c4 = await fixtureContext(browser); const pa = await c4.newPage(); watch(pa);
  await pa.addInitScript(() => { try { localStorage.setItem('me2:sound', 'true'); } catch {} });
  await pa.goto(BASE + '/'); await pa.waitForTimeout(500);
  await pa.click('#playDaily'); await pa.waitForTimeout(200);
  check('"Jogar o diário" sem conta abre o diálogo no passo do apelido', (await step(pa)) === 'nick');
  await authFlow(pa, { nick: nick + 'c', pw: PW_C, create: true });
  check('conta nova: e-mail pulado, botão "Jogar!"', (await pa.textContent('#aSubmit')).trim() === 'Jogar!');
  await pa.click('#aSubmit'); await acceptLegal(pa);
  await pa.waitForSelector('#introScreen', { timeout: 5000 });
  check('intro abre em tela cheia na 1ª partida da conta', await pa.isVisible('#introScreen .intro-slide.on svg') && (await pa.textContent('#introScreen .intro-cap p')).includes('Vorkaro'));
  check('SVG da intro sem <script> (sanitizado)', await pa.evaluate(() => !document.querySelector('#introScreen script') && !window.__fixtureScriptRan));
  check('intro: um único botão "Pular" + Som', (await pa.$$('#introScreen .intro-ctl button')).length === 1 && (await pa.textContent('#introScreen .intro-next')).trim() === 'Pular');
  await pa.waitForTimeout(400);
  check('música da intro tocando (som ligado)', (await pa.evaluate(() => GameAudio._state().music.intro)) === true, await pa.evaluate(() => GameAudio._state()));
  await pa.click('#introScreen .intro-next'); await pa.waitForTimeout(200);
  check('"Pular" avança uma cena', (await pa.textContent('#introScreen .intro-count')).startsWith('2/'));
  await pa.click('#introScreen .intro-next'); await pa.waitForTimeout(200);
  check('cena 3 de 3', (await pa.textContent('#introScreen .intro-count')).startsWith('3/'));
  await pa.click('#introScreen .intro-next'); await pa.waitForTimeout(500);
  check('"Pular" no último slide entra no jogo: carta aparece', !(await pa.$('#introScreen')) && await pa.isVisible('#card') && await pa.evaluate(() => !!s && s.mode === 'daily'));
  check('intro marcada como vista para esta conta', await pa.evaluate(() => store.get('introSeen', false) === true));
  if (await pa.isVisible('#tut')) await pa.click('#tutOk');
  await pa.waitForTimeout(1200);
  check('tema em loop durante a partida', (await pa.evaluate(() => GameAudio._state().music.tema)) === true, await pa.evaluate(() => GameAudio._state()));
  const full = await seq(pa, 10);
  // áudio: sirene na carta de polícia (sem repetir em sequência) e derrota ao ser preso
  check('cartas de polícia reconhecidas', await pa.evaluate(() => isPolice('busca') && isPolice('pf2') && isPolice('oc_pf_cambio') && isPolice('oc_mala') && isPolice('motorista') && !isPolice('entrada')));
  await pa.evaluate(() => { s.card = 'busca'; render(); dealIn(); });
  const sir1 = await pa.evaluate(() => GameAudio._state().sfx.sirene || 0);
  await pa.evaluate(() => { dealIn(); });
  const sir2 = await pa.evaluate(() => GameAudio._state().sfx.sirene || 0);
  check('sirene toca na carta da PF e não repete em sequência rápida', sir1 > 0 && sir1 === sir2, { sir1, sir2 });
  await pa.evaluate(() => { setSound(false); });
  check('botão Som desliga a música', (await pa.evaluate(() => GameAudio._state().music.tema)) === false);
  await pa.evaluate(() => { setSound(true); }); await pa.waitForTimeout(600);
  await pa.evaluate(() => finish('preso')); await pa.waitForTimeout(800);
  const st = await pa.evaluate(() => GameAudio._state());
  check('preso: tema para e toca a derrota', st.music.tema === false && st.music.derrota === true, st);
  await pa.click('#btnHome'); await pa.waitForTimeout(300);
  // "Ver a intro" na ajuda (fixture): abre e o Pular avança até sair
  await pa.click('#openHelp'); await pa.click('#btnIntro'); await pa.waitForSelector('#introScreen', { timeout: 5000 });
  check('"Ver a intro" na ajuda abre o player', await pa.isVisible('#introScreen'));
  await pa.keyboard.press('Escape'); await pa.waitForTimeout(150);
  check('Esc no player = Pular (avança uma cena)', (await pa.textContent('#introScreen .intro-count')).startsWith('2/'));
  for (let i = 0; i < 3 && await pa.$('#introScreen'); i++) { await pa.click('#introScreen .intro-next'); await pa.waitForTimeout(150); }
  await pa.waitForTimeout(300);
  check('intro fecha e volta para a ajuda', !(await pa.$('#introScreen')) && await pa.isVisible('#helpScreen'));
  await c4.close();

  const c5 = await plainCtx(browser); const pb = await c5.newPage(); watch(pb);
  await pb.goto(BASE + '/'); await pb.waitForTimeout(500); await pb.click('#playDaily');
  await authFlow(pb, { nick: nick + 'd', pw: PW_C, create: true }); await pb.click('#aSubmit'); await acceptLegal(pb); await pb.waitForTimeout(600);
  if (await pb.isVisible('#tut')) await pb.click('#tutOk');
  const first = await seq(pb, 5);
  await pb.reload(); await pb.waitForTimeout(800); await pb.click('#btnResume'); await pb.waitForTimeout(700);
  const rest = await seq(pb, 5);
  check('retomada mantém as mesmas cartas', JSON.stringify(full) === JSON.stringify(first.concat(rest)), { full, resumed: first.concat(rest) });
  await c5.close();

  // 8. esqueci a senha (última: troca encerra as sessões)
  await p2.evaluate(() => { try { localStorage.removeItem('me2:auth'); } catch {} }); await p2.reload(); await p2.waitForTimeout(600);
  await p2.click('#loginOpen'); await p2.fill('#aNick', nick); await p2.click('#aSubmit'); await waitStep(p2, 'login');
  await p2.click('#aForgot'); await waitStep(p2, 'reset');
  const rcode = await p2.evaluate(() => window.__devCode); await p2.fill('#aCode', rcode || '000000'); await p2.fill('#aPass', PW_NEW); await p2.click('#aSubmit');
  await waitStep(p2, 'login');
  check('troca de senha volta para "Digite sua senha"', (await p2.textContent('#authLead')).includes('Senha trocada'));
  await p2.fill('#aPass', PW_NEW); await p2.click('#aSubmit'); await p2.waitForTimeout(900);
  check('entra com a senha nova', (await p2.textContent('#accountInfo')).includes('@' + nick));

  // 9. excluir conta
  p2.on('dialog', d => d.accept());
  await p2.click('#deleteAcctBtn'); await p2.waitForSelector('dialog.pwask input[type=password]');
  await p2.fill('dialog.pwask input', PW_NEW); await p2.click('dialog.pwask button[type=submit]'); await p2.waitForTimeout(1000);
  check('conta excluída e deslogada', await p2.isVisible('#loginOpen'));

  check('sem erros de página nem violações de CSP', errors.length === 0, errors);
  await browser.close();
  console.log(failures ? failures + ' falha(s)' : 'e2e ok');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
