# Intro em formato de trailer (Saldo Zero)

Projeto `saldo-zero` (EBENIX TECNOLOGIA INOVA SIMPLES (I.S.), CNPJ 68.730.443/0001-71). Direção do DESIGNER, execução do EDITOR. Mesma linguagem das cenas da home: ilustração editorial chapada, meio-tom, paleta ink/papel/vermelho plantão/dourado, cinemagraph (só alguns elementos se mexem). Tudo fictício: silhuetas anônimas, sem logos reais, PF = "Polícia Federativa", imprensa = "O Glubu"/"Rede Glubu".

## Arquivos
- `public/intro/slide-1.svg` a `slide-8.svg` (viewBox 400x800, `slice`, só CSS interno, sem script nem referência externa; ~40 KB no total). Respeitam `prefers-reduced-motion`.
- `public/intro/intro.json` (contrato com o player): `slides[{file,caption,ms}]` e `music`. Soma dos `ms` = 28000 = duração da música.
- `public/intro/demo.html`: página de QA (avanço automático, botão único "Pular"). `?slide=N` congela; `?w=360` simula largura.
- `public/audio/`: `intro-samba.mp3`, `tema-bossa.mp3` (loop), `sirene.mp3`, `derrota.mp3`.

## Composição para celular (retrato)
Assunto principal no terço central/superior (até ~y 530 de 800); terço de baixo livre para legenda e botão Pular. Fundos sangram até as bordas; a página aplica a legenda por cima.

## Roteiro (legendas)
1. EXTRA! O Glubu revela: nasce um banqueiro. (3,0 s)
2. Tudo começou num bancão de bairro, quase falido. (3,5 s)
3. Danilo Vorkaro herda as chaves do Banco Maxter. (3,5 s)
4. Ambição de sobra: crescer, crescer e crescer. (3,5 s)
5. Brasília chama. Festas, jatinhos e charutos. (3,5 s)
6. Aí chega a Polícia Federativa. Que susto! (3,5 s)
7. Rede Glubu: plantão 24 horas sobre você. (3,5 s)
8. Sobreviva ao poder até quando der. (4,0 s)

Flashes: a viatura alterna a 1 Hz com opacidade entre 0,3 e 1 (abaixo do limite WCAG 2.3.1).

## Áudio e créditos
A API Eleven Music (`POST /v1/music`) respondeu 402 `paid_plan_required` ("Music API is not available for free users"). Plano `free`, 10.000 créditos; nada foi contratado. Alternativa: `POST /v1/sound-generation` (10 créditos por segundo, máx. 22 s por chamada). Consumo: sirene 30 + derrota 50 + intro 100 (10 s) + bossa 55 (5,5 s) = 235 créditos; restam cerca de 2, e a cota só renova no ciclo mensal. Por isso `intro-samba` foi montada com o trecho de 10 s repetido 3 vezes com crossfade (28 s), e `tema-bossa` com o trecho de 5,5 s repetido 12 vezes com crossfade e emenda de loop (~60 s). Substituir por faixas do Eleven Music (ou outra fonte lícita) quando houver plano pago. Loudnorm: músicas perto de -16,6 a -16,9 LUFS, sirene mais baixa.
