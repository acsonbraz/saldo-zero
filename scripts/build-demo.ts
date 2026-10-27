// Gera a demo estática em demo/ (hospedável no GitHub Pages ou em qualquer servidor de arquivos).
// Uso: bun scripts/build-demo.ts
// Troca os caminhos absolutos por relativos (a página fica em subpasta), usa as fontes locais, não registra service
// worker e injeta scripts/demo-api.js, que simula a API no navegador. Sem loja, sem contas reais, sem ranking global.
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url).pathname;
const out = root + "demo/";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const dir of ["fonts", "scenes", "intro", "audio", "js"]) await cp(root + "public/" + dir, out + dir, { recursive: true });
for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png", "og.png", "manifest.webmanifest"]) await cp(root + "public/" + f, out + f);
await cp(root + "scripts/demo-api.js", out + "demo-api.js");

const rel = (s: string) => s
  .replace(/(["'(=])\/(fonts|scenes|intro|audio|js|icon-|apple-touch|manifest|og\.)/g, "$1$2");

const fontsCSS = `<style>
@font-face{font-family:'Anton';font-style:normal;font-weight:400;font-display:swap;src:url(fonts/Anton.woff2) format('woff2')}
@font-face{font-family:'Rubik';font-style:normal;font-weight:300 900;font-display:swap;src:url(fonts/Rubik.woff2) format('woff2')}
@font-face{font-family:'Rubik';font-style:italic;font-weight:300 900;font-display:swap;src:url(fonts/Rubik-Italic.woff2) format('woff2')}
</style>`;
const GF = /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/;
let game = await readFile(root + "game.html", "utf8");
game = GF.test(game) ? game.replace(GF, fontsCSS) : fontsCSS + game;
game = rel(game).replace('<script src="js/game-audio.js">', '<script src="demo-api.js"></script>\n<script src="js/game-audio.js">');

const title = "Saldo Zero (demo) · Você é o banqueiro. Quantos dias até a PF chegar?";
const description = "Demo jogável do Saldo Zero: jogo satírico de decisões em cartas, estilo Reigns. Código aberto (MIT).";
const head = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0d1020">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="icon" href="icon-192.png" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Saldo Zero">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="og.png">
<meta name="twitter:card" content="summary_large_image">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}img{max-width:100%}[hidden]{display:none!important}#emailNudge{display:none!important}.demo-foot{margin:18px auto 28px;max-width:560px;padding:0 16px;text-align:center;font:13px/1.5 Rubik,sans-serif;color:#9a9689}.demo-foot a{color:#e8b035}</style>
`;
const foot = `<p class="demo-foot">Versão demo: conta, progresso e ranking ficam só neste aparelho, sem loja. Código aberto (MIT) em <a href="https://github.com/acsonbraz/saldo-zero">github.com/acsonbraz/saldo-zero</a>. Desenvolvido por EBENIX Tecnologia.</p>`;
await writeFile(out + "index.html", head + game + foot + "\n</body>\n</html>\n");
for (const f of ["js/game-audio.js", "js/intro-player.js"]) await writeFile(out + f, rel(await readFile(out + f, "utf8")));
await writeFile(out + "manifest.webmanifest", rel(await readFile(out + "manifest.webmanifest", "utf8")));
console.log("demo/ pronta");
