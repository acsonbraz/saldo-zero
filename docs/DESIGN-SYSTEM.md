# Design System Saldo Zero v1.0.0

Projeto `saldo-zero` · produto da EBENIX TECNOLOGIA INOVA SIMPLES (I.S.), CNPJ 68.730.443/0001-71 · marca própria, **separada** de RHone, AssinAPI, Arremate Score, PERPlex, YourDress e YourKids (não reutilizar logos, cores ou tokens de outras marcas). Aprovado pelo dono em 19/10/2026 como "upgrade visual do que já é". Fonte da verdade: `game.html` (bloco `:root`, sprite `#i-*` e CSS), este documento e `docs/design/`.

## 1. Princípios
1. **Tabloide em edição extra.** O jogo é um jornal sensacionalista: tinta, papel-jornal, vermelho Plantão, dourado. Nada de gradientes decorativos, glow, cartões azulados iguais, emojis como ícone.
2. **Papel sobre tinta.** O conteúdo narrativo (carta, capa, toast) é papel; o aplicativo ao redor é tinta com meio-tom discreto.
3. **Formas de impressão.** Cantos curtos (3, 6, 10 px), sombras duras, filetes duplos, carimbos, desregistro.
4. **Legível primeiro.** WCAG 2.2 AA: contraste, alvo de toque >= 44 px, foco visível, movimento reduzido.

## 2. Cores (contraste calculado, WCAG 2.x)
| Token | Hex | Uso | Contraste |
| --- | --- | --- | --- |
| `--ink` | `#101114` | chão do app | base |
| `--ink-2` / `--ink-3` | `#181a1f` / `#22252c` | painéis / campos, botões de escolha | base |
| `--line` | `#34363e` | filetes decorativos (não é informação) | 1,7:1 (decorativo) |
| `--edge` | `#80828b` | bordas de controles | 4,6:1 sobre ink-2 (>= 3:1) |
| `--fg` | `#f2ecdc` | texto principal | 14,8:1 sobre ink-2 |
| `--mute` | `#a8a699` | texto secundário | 7,1:1 sobre ink-2 |
| `--paper` / `--paper-2` | `#f1e9d2` / `#e5dac0` | carta, capa, toast | base |
| `--paper-ink` | `#17151c` | texto sobre papel | 14,9:1 |
| `--paper-mute` | `#55505c` | texto secundário sobre papel (era `#5c5868` sobre bege) | 6,4:1 (paper), 5,6:1 (paper-2) |
| `--red` | `#d9202f` | faixas e grafismos, texto >= 24 px | 3,8:1 sobre ink (grande/gráfico) |
| `--red-solid` | `#c8182b` | fundo com texto branco pequeno | 4,9:1 |
| `--red-ink` | `#ff6b78` | texto vermelho sobre tinta (perigo) | 6,9:1 |
| `--red-paper` | `#b3121f` | texto vermelho sobre papel | 5,7:1 |
| `--gold` | `#e8b23a` | ação primária, destaque | 9,8:1 sobre ink; texto `ink` sobre ouro 9,8:1 |
| `--gold-deep` | `#8a5a0c` | sombra dura do botão | decorativo |
| `--ok` | `#5fd0a0` | confirmação | 9,1:1 |

Os indicadores deixam de ter 4 cores (verde/azul/rosa/vermelho): a **forma do ícone** e o rótulo distinguem; a barra é papel e vira vermelho só em perigo. Cores propostas, não oficiais além do jogo: não replicar em outros produtos.

Texturas: `--grain` (ruído SVG feTurbulence, papel) e `--dots` (meio-tom 7 px sobre tinta). Aplicadas só em papel e fundo.

## 3. Tipografia
Anton (display, caixa alta, licença local em `public/fonts`) e Rubik (texto, variável 300-900, itálico). `@font-face` está em `game.html`; o link do Google Fonts foi removido (jogo sem chamada externa).

| Papel | Fonte | Tamanho |
| --- | --- | --- |
| Marca (home) | Anton | 56 (mobile) / 64 (desktop) |
| H1 tela | Anton | 34 a 44 (home 40) |
| Manchete da capa | Anton | 30 a 34 (canvas 80 a 108) |
| Rótulos caixa-alta | Anton / Rubik 700, tracking 1,2 a 2 px | 11 a 15 |
| Texto da carta | Rubik 400, entrelinha 1,34 | 21 / 19,5 / 18 / 17 conforme o tamanho do texto (`sayFs`) |
| Plantão na carta | Anton | 32 / 28 / 24 / 21 |
| Corpo | Rubik | 13,5 a 15 (mínimo 12) |

## 4. Espaçamento, formas, sombras
Espaçamento base 4/8 (gaps 8, 10, 14, 16). Raios: `--r1` 3 (etiquetas, carimbos), `--r2` 6 (botões, painéis), `--r3` 10 (carta). Sombras: dura `0 3px 0 #000` (botões), `0 4px 0 --gold-deep` (primário), carta `0 18px 36px #000a`. Filetes: duplo 3 px (mastro), 1 px pontilhado (cartas). Alvos de toque >= 44 px.

## 5. Iconografia
Sprite SVG inline (`<symbol id="i-*">`), grade 24, **traço único 1,75 px**, ponta quadrada, junta em ângulo, sem preenchimento (exceto `silhueta`). Uso: `ic('nome', tamanho)` no JS ou `<svg class="i"><use href="#i-nome"/></svg>`; herdam `currentColor`. Conjunto: indicadores (caixa, poder, imagem, radar), 10 finais (preso, falencia, miami, dono, descartado, cancelado, idolo, delator, exilio, lenda), final bloqueado = `silhueta`, tipos de carta (jornal, zap, reuniao, sirene), interface, jogadas do Vorkaro, 17 itens da coleção. Emojis não são ícones; `noEmoji()` limpa toasts e ticker.

## 6. Motion
Easings: `--ease-out cubic-bezier(.16,1,.3,1)` (entrada da carta 380 ms, barra 500 ms), `--ease-io cubic-bezier(.45,0,.55,1)` (pulso 1,4 s). Amplitudes pequenas (carta 30 px, tremor 6 px). `prefers-reduced-motion: reduce` desliga todas as animações e transições; o Plantão passa a mostrar a manchete mais recente parada. Perigo tem alternativa estática (borda vermelha 2 px, selo de alerta, barra e valor em vermelho, `aria-valuetext` "nível crítico"). Plantão tem botão pausar/retomar (`#tickToggle`, preferência salva).

## 7. Componentes
- **Carta** (`.card`): papel com grão, faixa superior (tinta; vermelha em Plantão/Ocorrência), cabeçalho com ícone do tipo, avatar 64 px, texto adaptativo, marca d'água do tipo (6%), etiquetas ESQUERDA/DIREITA em carimbo durante o arrasto. `data-kind` = oc | news | zap | meet. As opções ficam só nos botões abaixo.
- **Indicadores** (`.stat`, `role=button` abre a explicação; a barra interna é `role="meter"` com `aria-valuenow/valuetext`): ícone 21 px, rótulo, barra com marcas de 25%, valor. Pontos de impacto (`.dot`) no arrasto. Sem `aria-live`; anúncios só pelo toast.
- **Botões**: primário `.big` (ouro, sombra dura, 52 px), secundário `.big.alt` (contorno `--edge`), escolha `.choices button` (>= 84 px), rodapé `.foot button` (>= 44 px, ícone + rótulo).
- **Toast "MANCHETE"**: papel, filete vermelho, **no topo** (nunca sobre os botões), `role=status aria-live=polite`, z-index acima das telas.
- **Plantão**: faixa vermelha em bandeira, texto rolando 70 px/s, pausável.
- **Capa final** (`.paper` e PNG 1080x1350 em canvas, `renderCover()`): mastro, data/modo/preço, faixa EDIÇÃO EXTRA, manchete, subtítulo, selo de dias e carimbo do final em faixa própria (sem cobrir texto), 4 indicadores, rodapé com a URL pública. Compartilhamento: `navigator.share({files})`; se não houver suporte, baixa a imagem e copia o texto.
- **Loja** (`.shop .item`, `.item.vip`): ícone em moldura, preço, selo; VIP com dupla moldura dourada. Preço riscado e cronômetro inalterados (decisão do dono).
- **Telas de conta** (`.form`, `.panel`, `.nudge`): campos 48 px, borda `--edge`, foco ouro, erro `--red-ink`.
- **Login em etapas** (`#authDlg`, `<dialog>` modal): apelido -> senha (nova, com regras ao vivo; ou de entrada, com "Esqueci a senha") -> e-mail (opcional, "pular por agora") -> "Jogar!". No celular ocupa a tela inteira na altura do `visualViewport` (o rodapé com o botão principal fica acima do teclado virtual); no desktop vira cartão de 440 px. Campos 52 px, botão mostrar/ocultar com `aria-pressed`, regras com marcador ok/pendente (sem depender só de cor), erro em `--red-ink` com `role=alert`, Esc e X fecham, foco no primeiro campo de cada passo. Capturas: `docs/design/shots/login/` (360x640, 390x844, 430x932, 1280x800).
- **Abertura** (`#introScreen`, `public/js/intro-player.js`): tela cheia `100dvh` com safe-area, barra de progresso por cena, selo AO VIVO, SVG da cena inline, legenda em faixa de telejornal (selo PLANTÃO vermelho + papel com Anton 17 a 24 px e filete vermelho), um único botão "Pular" (ouro, >= 56 px, zona do polegar) que avança uma cena e, na última, entra no jogo; botão Som. Crossfade 600 ms; com movimento reduzido, sem animação nem crossfade.
- **Tela inicial**: `#homeScenes` (cenas desfocadas, ver `docs/design/DIRECAO-CENAS-HOME.md`), marca + faixa PLANTÃO, hero, resumo do desafio, Jogar o diário (primário), Modo livre (secundário, texto curto), conta, ranking, finais, coleção.

## 8. Acessibilidade e QA
Contraste verificado (tabela acima, script de cálculo WCAG); foco visível ouro 3 px; alvos >= 44 px; `role=meter`; `reduced-motion`; sem informação só por cor. Testado em Chromium (Playwright) a 390x844 e 1280x800, movimento reduzido: capturas em `docs/design/shots/`. Não testado: Safari/iOS real, leitor de tela real, share com arquivos em dispositivo.

## 9. Governança
Semver deste sistema: 1.0.0 (19/10/2026). Mudança de token ou ícone: editar `:root` / sprite em `game.html` e este arquivo. Logo e identidade nova exigem aprovação do dono. Itens de dados (textos, personagens, datas, rodapé) são do NERD.
