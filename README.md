# SALDO ZERO

Jogo narrativo satírico e fictício. Você é um banqueiro tentando sobreviver ao poder: arraste cartas, segure o caixa e fuja da Operação Saldo Zero. Roda no navegador (mobile first) como PWA: instala na tela inicial e funciona sem internet.

## Execução (web)

Requer [Bun](https://bun.sh/).

```bash
bun run start
```

O servidor monta a página em memória a partir de `game.html`, troca o Google Fonts pelas fontes locais, serve o PWA (manifesto, service worker, ícones), as páginas `/privacidade` e `/suporte` e a API (conta de jogo, loja, ranking). `./build.sh` gera um `index.html` standalone (não versionado) quando for preciso um arquivo estático.

### Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `PORT` | porta (padrão 3000) |
| `SITE_URL` | domínio público, usado nas tags de preview e no retorno do pagamento (ex.: `https://vorkaro.site`) |
| `DATA_DIR` | pasta do banco SQLite (no Railway, o volume em `/data`) |
| `ASAAS_API_KEY` | chave da API do Asaas; sem ela a loja fica desligada |
| `ASAAS_ENV` | `sandbox` (padrão) ou `production` |
| `ASAAS_WEBHOOK_TOKEN` | token configurado no webhook do Asaas (header `asaas-access-token`) |
| `ADMIN_TOKEN` | senha do painel do desenvolvedor em `/admin` (mínimo 16 caracteres) |
| `RESEND_API_KEY` | chave do Resend para e-mails de confirmação e recuperação de PIN; sem ela o código só vai para o log |
| `RESEND_FROM` | remetente em domínio verificado no Resend (padrão `Saldo Zero <contato@vorkaro.site>`) |
| `RESEND_REPLY_TO` | endereço que recebe respostas aos e-mails (padrão `contato@vorkaro.site`) |
| `DEV_CODES` | `1` apenas em testes: devolve o código na resposta da API. O servidor **recusa subir** com `DEV_CODES=1` e `ASAAS_ENV=production` |
| `TRUST_PROXY` | `1` para confiar em `X-Real-IP` fora do Railway (no Railway é automático via `RAILWAY_ENVIRONMENT`) |
| `GLOBAL_AUTH_PER_MIN` | limite global de tentativas de PIN/código por minuto, somando todos os IPs (padrão 600) |
| `BACKUP_DISABLED` | `1` desliga o backup diário local |

### Conta de jogo, loja e ranking

- Conta: apelido único (3 a 16 caracteres, sem acento) + PIN. Contas novas e trocas de PIN exigem 6 a 8 números e recusam PINs óbvios (000000, 123456, 121212...); contas antigas com PIN de 4 continuam entrando. 5 erros seguidos bloqueiam a conta por 1 min, dobrando a cada erro (até 24 h), com o contador gravado no banco. Códigos de e-mail: aleatórios (`crypto.getRandomValues`), guardados como hash, 30 min de validade, até 5 envios e 10 erros por conta a cada 24 h. Sessões: só o hash SHA-256 do token fica no banco; expiram com 30 dias sem uso ou 90 dias desde o login; "Sair de todos os aparelhos" e "Excluir minha conta" (pede o PIN; pedidos pagos ficam anonimizados por obrigação fiscal) no painel da conta. O e-mail é opcional no cadastro: depois da primeira carta jogada, um lembrete fixo pede para cadastrar e confirmar (código de 6 dígitos via Resend). Compras exigem e-mail confirmado; o ranking não. "Esqueci o PIN" envia um código de troca.
- VIP para sempre (`com.saldozero.vip`, R$ 19,90, de R$ 59,90): 15 favores por partida, baralho eleitoral, escolha de capa e destaque no ranking. A loja mostra o preço riscado, o desconto e um cronômetro de 15 minutos em loop.
- Favores: moeda das jogadas do Vorkaro e dos recursos no modo livre. Toda partida começa com 2; pacotes de 10 e 30 ficam na conta.
- Loja (Asaas, checkout hospedado com Pix, cartão e boleto): `POST /api/checkout` cria a cobrança, o jogador paga na página do Asaas e volta para `SITE_URL/?pedido=<ref>`; `GET /api/order/:id` (só o dono; responde pelo banco e consulta o Asaas se pendente há mais de 30 s); `POST /api/webhook/asaas` confere o token em tempo constante, reconsulta a cobrança no Asaas e sempre responde 200 depois do token. Estorno/chargeback revoga o item; favores de pacote estornado são descontados e o saldo pode ficar negativo (o servidor não deixa gastar sem saldo). Um pagamento libera produto para uma única conta (`entitlements.payment_id` único). `POST /api/restore` exige login e só liga pedidos do próprio usuário ou sem dono cujo CPF/CNPJ bate com o da cobrança. Os itens valem a partir de `/api/me`; o localStorage é só cache.
- Ranking diário: o dia é o de Brasília (America/Sao_Paulo), calculado no servidor; `POST /api/daily` aceita só o dia corrente (10 min de tolerância após a meia-noite) e recusa resultados impossíveis para o motor (5 a 27 dias por decisão, no máximo 760 dias, "lenda" só a partir do dia 730); `GET /api/daily?day=` lista o top 50. No diário todo mundo tem 2 favores (inclusive VIP) e, ao retomar uma partida, o estado do gerador é restaurado: mesmas cartas para todos.
- Ajuda e suporte: menu Ajuda no jogo (como jogar, indicadores, favores, compras) com formulário de chamado (`POST /api/support`); o jogador vê a resposta no mesmo menu.
- Painel do desenvolvedor em `/admin` (token em `ADMIN_TOKEN`): receita total, do mês e do dia, vendas por produto, lista de cobranças, usuários (bloquear, excluir, dar ou tirar favores, dar ou remover produtos, trocar PIN, renomear, anotação) e chamados com resposta.
- Balanceamento: três decisões seguidas puxando o mesmo indicador (obsessão) encolhem o ganho e dobram os efeitos colaterais; indicador acima de 70 aquece o radar a cada turno e acima de 80 drena outro; acima de 75 cada ponto ganho vale metade (90: um terço); jogadas do Vorkaro repetidas rendem menos e custam mais. Ocorrências (`oc:true` no baralho) aparecem em ~20% dos turnos a partir do 3º, com opções cujo resultado é uma função do estado (`(s,rng)=>[fx,meta]`).
- Segurança HTTP: CSP só com `'self'` e o hash dos scripts inline (calculado no boot; atributos `onclick="..."` não funcionam), HSTS, `nosniff`, `Referrer-Policy`, `frame-ancestors 'none'`. IP do cliente: no Railway vem de `X-Real-IP` (gravado pela borda); na falta, o último item de `X-Forwarded-For`.
- Operação: `bun server.ts` direto; `GET /health` testa o banco; SIGTERM fecha o banco; backup diário com `VACUUM INTO` em `DATA_DIR/backups` (7 arquivos). Backup externo (bucket) ainda pendente de aprovação de gasto: o backup local não protege contra perda do volume.
- Testes: `bun run test` (`scripts/test-api.ts`, asserts de API: sobe Asaas falso e servidor sozinho); `scripts/fake-asaas.ts` imita o Asaas, com webhook e estorno; `scripts/e2e.cjs` percorre conta, compra, itens vindos do servidor, ranking, retomada e exclusão no navegador (Playwright, asserts); `scripts/balance.cjs` simula estratégias (só imagem, só poder, cuidadoso, aleatório) no motor real e mostra a distribuição de finais.

## Arquivos

- `game.html` — todo o jogo (estilos, baralho, mecânicas, telas, ponte com o app nativo).
- `server.ts` — servidor Bun.
- `store.ts`, `auth.ts`, `admin.ts`, `db.ts` — loja (Asaas), conta de jogo e suporte, painel do desenvolvedor, banco SQLite.
- `admin.html` — painel do desenvolvedor (servido em `/admin`).
- `scripts/sim.cjs` — joga dezenas de partidas aleatórias em Chromium headless e imprime a distribuição de finais e erros de console.
- `public/` — manifesto do PWA, service worker, ícones, imagem de preview (`og.png`) e fontes.
- App iOS (xtool + StoreKit) guardado na branch `claude/ios-app`, caso a distribuição em loja volte à pauta.

## Hospedagem

Projeto Railway `master-escape`; serviço `master-game-github`, conectado à branch `main` para deploy automático.

## Nomes

- App e marca: **Saldo Zero**.
- Banco do jogo: **Banco Maxter**. Protagonista: Danilo Vorkaro.
- Obra de ficção e sátira: personagens, bancos, veículos e instituições são inventados.
