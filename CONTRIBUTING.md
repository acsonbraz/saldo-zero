# Contribuindo · Contributing

O Saldo Zero é um projeto **encerrado** pela EBENIX Tecnologia: não há manutenção ativa nem prazo de resposta. Mesmo assim, contribuições são bem-vindas e podem ser aceitas quando der. / *The project is closed upstream (no active maintenance or response times), but contributions are welcome and merged when possible.*

## Boas formas de começar

- **Cartas novas**: histórias novas, no mesmo tom de sátira ficcional (ver `CARDS` em `game.html`). Nada de pessoas reais identificáveis nem acusações.
- **Traduções**: cartas, finais, itens e interface para inglês, espanhol etc. Abra uma issue antes para combinar o formato (arquivos de idioma ou uma branch por idioma).
- **Acessibilidade**: leitores de tela, contraste, foco, movimento reduzido.
- **Balanceamento**: `scripts/sim.cjs` joga dezenas de partidas aleatórias e mostra a distribuição de finais.
- **Pagamentos**: adaptadores para outros meios (Stripe, Mercado Pago, Pix direto), mantendo o Asaas como padrão.
- **Docs e exemplos**: guias de "crie o seu jogo", exemplos de histórias em outros temas.

Procure as issues com o rótulo `good first issue`.

## Como contribuir

1. Faça um fork e crie uma branch (`git switch -c minha-mudanca`).
2. Rode o jogo (`bun run start`) e os testes (`bun run test`; o e2e está descrito no topo de `scripts/e2e.cjs`).
3. Mantenha o estilo existente (código enxuto, textos em português do Brasil, design system em `docs/DESIGN-SYSTEM.md`).
4. Abra um pull request descrevendo o que mudou e como testou.

## Regras de conteúdo

- É uma **obra de ficção e sátira**: personagens, bancos e instituições são inventados. Não envie conteúdo que ataque, difame ou identifique pessoas reais.
- Nada de dados pessoais, chaves ou segredos em commits. Use variáveis de ambiente (ver README).
- Seja gentil: respeito acima de tudo nas issues e nos PRs.

## Licença

Ao contribuir, você concorda que seu código segue a licença MIT do projeto (ver `LICENSE`).
