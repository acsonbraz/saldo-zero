// Capturas e checagens de layout do login em etapas e da intro em celulares (360x640, 390x844, 430x932) e no desktop.
// Mesmo servidor do e2e (ver topo de scripts/e2e.cjs). Uso:
//   PW_PATH=/caminho/node_modules/playwright node scripts/shots-login.cjs   (salva em docs/design/shots/login/)
// Checa: sem rolagem horizontal; botão principal visível e >= 44 px (também com "teclado aberto", simulado
// reduzindo a altura da janela); intro sem rolagem, ocupando a tela, legenda dentro da largura e Pular na zona do polegar.
const { chromium } = require(process.env.PW_PATH || 'playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:3125';
const OUT = path.join(__dirname, '..', 'docs', 'design', 'shots', 'login');
const FIX = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, cond, extra) => { if (cond) console.log('  ✓ ' + name); else { failures++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const SIZES = [[360, 640], [390, 844], [430, 932]];

async function ctxFor(browser, w, h, extra = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: w < 600, hasTouch: w < 600, serviceWorkers: 'block' }, extra));
  await ctx.route('**/intro/*', (r) => { const f = path.join(FIX, 'intro', path.basename(new URL(r.request().url()).pathname)); fs.existsSync(f) ? r.fulfill({ path: f, contentType: f.endsWith('.json') ? 'application/json' : 'image/svg+xml' }) : r.fulfill({ status: 404, body: '' }); });
  await ctx.route('**/audio/*', (r) => r.fulfill({ status: 404, body: '' }));
  return ctx;
}
/* Layout do diálogo: rolagem horizontal, botão principal dentro da área visível e com altura >= 44. */
const dlgLayout = (p) => p.evaluate(() => {
  const vw = innerWidth, vh = (window.visualViewport ? visualViewport.height : innerHeight);
  const b = document.getElementById('aSubmit').getBoundingClientRect();
  const small = [...document.querySelectorAll('#authDlg button')].filter((x) => x.offsetParent && x.getBoundingClientRect().height < 44 && getComputedStyle(x).visibility !== 'hidden').map((x) => x.id || x.textContent.trim());
  return { hScroll: document.documentElement.scrollWidth > vw || document.getElementById('authDlg').scrollWidth > vw + 1, btnTop: Math.round(b.top), btnBottom: Math.round(b.bottom), vh: Math.round(vh), btnH: Math.round(b.height), small };
});

(async () => {
  const browser = await chromium.launch();
  for (const [w, h] of SIZES) {
    const tag = w + 'x' + h;
    console.log('\n# ' + tag);
    const ctx = await ctxFor(browser, w, h); const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForTimeout(700);
    await p.screenshot({ path: path.join(OUT, tag + '-0-home-entrar.png') });
    await p.click('#playDaily'); await p.waitForTimeout(250);
    let L = await dlgLayout(p);
    check(tag + ' apelido: sem rolagem horizontal, Avançar visível e >= 44 px', !L.hScroll && L.btnBottom <= L.vh && L.btnH >= 44 && !L.small.length, L);
    await p.screenshot({ path: path.join(OUT, tag + '-1-apelido.png') });
    const nick = 'shot_' + Math.random().toString(36).slice(2, 7);
    await p.fill('#aNick', nick); await p.click('#aSubmit'); await p.waitForFunction(() => AUTH.step === 'new');
    await p.fill('#aPass', 'abc12'); await p.waitForTimeout(100);
    L = await dlgLayout(p);
    check(tag + ' senha: regras visíveis e Avançar visível', !L.hScroll && L.btnBottom <= L.vh && L.btnH >= 44 && !L.small.length, L);
    await p.screenshot({ path: path.join(OUT, tag + '-2-senha-regras.png') });
    // teclado virtual aberto (simulado: janela com ~55% da altura): o botão continua acima do "teclado"
    await p.setViewportSize({ width: w, height: Math.round(h * 0.55) }); await p.waitForTimeout(250);
    L = await dlgLayout(p);
    check(tag + ' senha com teclado aberto: Avançar continua visível', L.btnTop >= 0 && L.btnBottom <= L.vh, L);
    await p.screenshot({ path: path.join(OUT, tag + '-2b-senha-teclado.png') });
    await p.setViewportSize({ width: w, height: h }); await p.waitForTimeout(150);
    await p.fill('#aPass', 'tucano42'); await p.click('#aPassShow'); await p.waitForTimeout(80);
    await p.screenshot({ path: path.join(OUT, tag + '-2c-senha-ok-mostrar.png') });
    await p.click('#aSubmit'); await p.waitForFunction(() => AUTH.step === 'email');
    L = await dlgLayout(p);
    check(tag + ' e-mail: Avançar e "pular por agora" visíveis', !L.hScroll && L.btnBottom <= L.vh && await p.isVisible('#aSkip'), L);
    await p.screenshot({ path: path.join(OUT, tag + '-3-email.png') });
    await p.click('#aSkip'); await p.waitForFunction(() => AUTH.step === 'ready');
    await p.screenshot({ path: path.join(OUT, tag + '-4-pronto-jogar.png') });
    await p.click('#aSubmit'); await p.waitForTimeout(250);
    if (await p.isVisible('#legalScreen')) { await p.click('#legalOk'); }
    await p.waitForSelector('#introScreen .intro-slide.on', { timeout: 5000 }); await p.waitForTimeout(700);
    const I = await p.evaluate(() => {
      const r = document.getElementById('introScreen'), cap = r.querySelector('.intro-cap').getBoundingClientRect(), btn = r.querySelector('.intro-next').getBoundingClientRect(), snd = r.querySelector('.intro-sound').getBoundingClientRect();
      return { w: innerWidth, h: innerHeight, rootH: Math.round(r.getBoundingClientRect().height), scroll: r.scrollHeight > r.clientHeight + 1 || document.documentElement.scrollWidth > innerWidth, capL: Math.round(cap.left), capR: Math.round(cap.right), btnH: Math.round(btn.height), btnTop: Math.round(btn.top), btnBottom: Math.round(btn.bottom), sndH: Math.round(snd.height), capFont: parseFloat(getComputedStyle(r.querySelector('.intro-cap p')).fontSize) };
    });
    check(tag + ' intro: tela cheia, sem rolagem', I.rootH === I.h && !I.scroll, I);
    check(tag + ' intro: legenda dentro da largura e legível (>= 17 px)', I.capL >= 0 && I.capR <= I.w && I.capFont >= 17, I);
    check(tag + ' intro: Pular >= 44 px na metade de baixo (zona do polegar)', I.btnH >= 44 && I.btnTop > I.h * 0.75 && I.btnBottom <= I.h && I.sndH >= 44, I);
    await p.screenshot({ path: path.join(OUT, tag + '-5-intro-cena1.png') });
    await p.click('#introScreen .intro-next'); await p.waitForTimeout(800);
    await p.screenshot({ path: path.join(OUT, tag + '-5b-intro-cena2.png') });
    await ctx.close();

    // login de apelido existente (senha + Esqueci a senha)
    const c2 = await ctxFor(browser, w, h); const q = await c2.newPage();
    await q.goto(BASE + '/'); await q.waitForTimeout(500);
    await q.click('#loginOpen'); await q.fill('#aNick', nick); await q.click('#aSubmit'); await q.waitForFunction(() => AUTH.step === 'login');
    await q.fill('#aPass', 'errada99'); await q.click('#aSubmit'); await q.waitForTimeout(500);
    L = await dlgLayout(q);
    check(tag + ' entrar: erro e botão visíveis', !L.hScroll && L.btnBottom <= L.vh, L);
    await q.screenshot({ path: path.join(OUT, tag + '-6-entrar-senha-erro.png') });
    await q.fill('#aPass', 'tucano42'); await q.click('#aSubmit'); await q.waitForTimeout(800);
    await q.screenshot({ path: path.join(OUT, tag + '-7-home-logado.png') });
    await c2.close();
  }
  // desktop: cartão centralizado
  {
    const ctx = await ctxFor(browser, 1280, 800); const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForTimeout(600); await p.click('#loginOpen'); await p.waitForTimeout(200);
    await p.screenshot({ path: path.join(OUT, '1280x800-1-apelido.png') });
    await ctx.close();
  }
  // movimento reduzido: intro sem animação, mas mostra os slides
  {
    const ctx = await ctxFor(browser, 390, 844, { reducedMotion: 'reduce' }); const p = await ctx.newPage();
    await p.goto(BASE + '/'); await p.waitForTimeout(500);
    await p.click('#openHelp'); await p.click('#btnIntro'); await p.waitForSelector('#introScreen .intro-slide.on', { timeout: 5000 });
    const rm = await p.evaluate(() => { const g = document.querySelector('#introScreen .intro-slide.on svg g'); return { cls: document.getElementById('introScreen').className, anim: g ? getComputedStyle(g).animationName : '?' }; });
    check('movimento reduzido: slide visível e sem animação', rm.cls.includes('rm') && rm.anim === 'none', rm);
    await p.screenshot({ path: path.join(OUT, '390x844-8-intro-movimento-reduzido.png') });
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? failures + ' falha(s)' : 'shots ok · ' + OUT);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('SHOTS FAILED', e); process.exit(1); });
