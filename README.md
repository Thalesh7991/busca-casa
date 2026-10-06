# Busca Imóveis

Agente de busca de imóveis para alugar, no estilo do [ai-job-search](../ai-job-search): raspadores por plataforma com contrato JSON comum, estado deduplicado entre execuções, e o Claude Code como camada de inteligência (`/scrape`, `/avaliar`, `/contato`, `/add-portal`). Por cima, uma **ferramenta web local** para ver fotos, custos e contatos, filtrar, ver no mapa e acompanhar o funil de cada imóvel.

Configurado para **Botucatu/SP, aluguel até R$ 2.000**. Zero dependências de runtime - só [Bun](https://bun.sh).

```
bun run scrape                /scrape (Claude Code)             bun run app
      |                              |                               |
varre 7 fontes em paralelo    triagem com nota 0-100,         http://localhost:3000
lê só os anúncios novos       alertas de golpe e custo        fotos, custos, contatos,
deduplica entre fontes        grava em data/imoveis.json      WhatsApp pronto, mapa, status
```

## Começando

Pré-requisito: Bun (`powershell -c "irm bun.sh/install.ps1 | iex"`).

```powershell
cd C:\Users\thale\Documents\busca_imoveis
bun install        # opcional: só tipos para o typecheck
bun run app        # sobe em http://localhost:3000 e abre o navegador
```

Na interface, **Buscar agora** varre as fontes (a primeira vez leva 2-3 min porque abre a página de cada anúncio; depois, segundos). Também dá para rodar no terminal: `bun run scrape`.

### Na interface
- **Abas** do funil: Novo → Interesse (★) → Contatado → Visita → Proposta, ou Descartado.
- **Filtros**: preço (no aluguel ou no custo total com condomínio + IPTU), quartos, tipo, fonte, aceita pet, mobiliado, com vaga, só da última busca.
- **Card**: botão **WhatsApp** abre a conversa com uma mensagem pronta (ref. + link do anúncio) e marca o imóvel como "contatado" (com desfazer).
- **Gaveta de detalhe**: galeria, custos mensais, todos os contatos (corretor com CRECI, imobiliária), notas suas, análise da IA, mapa, descrição, onde mais o mesmo imóvel está anunciado e histórico de preço.
- **Mapa**: pinos cheios = localização do anúncio; pontilhados = centro do bairro (aproximado).
- **Outros sites**: links já filtrados para ZAP, Viva Real, OLX, Imovelweb, Facebook e imobiliárias sem robô (ver abaixo).
- Link direto para um imóvel: `http://localhost:3000/#/imovel/<chave>` (ex.: `sai:8061`).

## Página publicada (GitHub Pages)

Cada push na `main` dispara o workflow [`.github/workflows/pagina.yml`](.github/workflows/pagina.yml), que roda os testes, varre as fontes e publica a interface em `https://<usuario>.github.io/<repo>/`. Ele também roda sozinho às 7h, 12h e 18h (Brasília) e sob demanda: botão **Atualizar** na página → **Run workflow** no GitHub.

- **Só leitura dos anúncios:** sem servidor, a página lê um `dados.json` gerado por `bun run exportar`. Status e notas que você marcar nela ficam **só naquele navegador** (não sincronizam com o `bun run app` local nem entre aparelhos).
- **Estado separado do local:** a busca do Actions tem o próprio estado, guardado no cache do Actions entre execuções. Seu `data/imoveis.json` (notas, status, análises do `/scrape`) continua só no seu computador.
- **É pública:** qualquer pessoa com o link abre. Ela pede para não ser indexada por buscadores e nunca leva suas notas pessoais, mas mostra os anúncios e contatos das imobiliárias. No plano gratuito do GitHub, o Pages exige repositório público.
- Configuração única no GitHub: *Settings → Pages → Source: GitHub Actions*.

## Com o Claude Code

Antes de tudo, preencha o **Perfil da busca** no [CLAUDE.md](CLAUDE.md) (quartos, pet, vaga, bairros, deal-breakers...) - a triagem pontua contra ele.

| Comando | O que faz |
|---|---|
| `/scrape` | Varre as fontes, dá nota 0-100 e alertas a cada anúncio novo (custo total, preço fora da curva, sinais de golpe), grava na base e mostra a lista com links de WhatsApp. `/scrape saude` checa se algum raspador quebrou. |
| `/avaliar <chave>` | Avaliação a fundo: custo real, comparação com a mediana do mercado, encaixe no perfil, perguntas para o anunciante, checklist de visita. Salva em `data/avaliacoes/`. |
| `/contato <chave>` | Redige a mensagem (WhatsApp e e-mail) e monta o link. **Nunca envia** - você envia. `/contato followup` sugere follow-ups para quem não respondeu. |
| `/add-portal <url>` | Adiciona uma imobiliária: detecta a plataforma, confere o robots.txt, testa e registra na config. |

## Fontes

| Fonte | Plataforma | Situação |
|---|---|---|
| Robuste, Pontes, Molina, Dupla | msys (API JSON) | ativas |
| S.A Imóveis, Rede Concreto | KSI (HTML) | ativas |
| Chaves na Mão | agregador (JSON-LD) | ativa - traz RE/MAX Invest, L4S, Daiane Bonan, ADM, Cecília Barros, Débora Martins, Realize... |
| Expande, Essencial, Amelia Ramos | Kenlo | **desativadas**: o robots.txt proíbe robôs. O adaptador está pronto; ativar é decisão sua (`"ativo": true` em `config/busca.json`), para uso pessoal e baixo volume. Parte do estoque delas já vem pelo Chaves na Mão. |
| ZAP, Viva Real, OLX, Imovelweb | - | bloqueiam robôs (Cloudflare) → só links manuais na aba "Outros sites" |
| QuintoAndar | - | não atende Botucatu |

Regras de acesso: User-Agent honesto (`busca-imoveis/1.0; uso pessoal`), no mínimo 350 ms entre requisições ao mesmo site, nenhuma tentativa de contornar bloqueio. Detalhes técnicos de cada plataforma em [docs/portais.md](docs/portais.md).

## Configuração (`config/busca.json`)

| Campo | Para quê |
|---|---|
| `cidade`, `uf`, `ddd` | onde buscar |
| `aluguel_max` | teto do aluguel (aplicado nas fontes; o filtro por custo total fica na interface) |
| `tipos`, `quartos_min` | filtros mecânicos da varredura |
| `buscar_detalhes` | abrir a página de cada anúncio novo (condomínio, IPTU, corretor, descrição completa) |
| `atualizar_a_cada_horas` | busca automática enquanto o servidor estiver aberto (0 = só manual) |
| `mensagem_whatsapp` | modelo da mensagem - `{titulo}`, `{ref}`, `{bairro}`, `{aluguel}`, `{url}`, `{anunciante}` |
| `fontes` | imobiliárias/portais: `id`, `nome`, `plataforma`, `url`, `ativo`, `apelidos` (nomes em agregadores), `aviso` |
| `busca_manual` | links da aba "Outros sites" |

## Terminal

```powershell
bun run scrape [--fonte robuste,sai] [--sem-detalhes] [--format json]
bun run estado resumo | estatisticas | listar [--status novo] [--novos] | ver <chave>
bun run estado status <chave> interesse        # novo|interesse|contatado|visita|proposta|descartado
bun run estado nota <chave> "visita sexta 18h"
bun run portal fontes | saude [--detalhe]
bun run portal search <fonte> --pages 1 --format table
bun run portal detail <fonte> <url> --format plain
bun run exportar [pasta]                        # página estática em _site/ (o que o Actions publica)
bun test                                        # 72 testes offline (fixtures reais)
$env:LIVE=1; bun test tests/live.test.ts        # 1 página por fonte, ao vivo
bun run typecheck
```

## Estrutura

```
busca_imoveis/
├── CLAUDE.md                 # perfil da busca + regras do agente
├── config/busca.json         # critérios e fontes
├── src/
│   ├── lib/                  # contrato (types), HTTP educado, texto/preço/telefone, config
│   ├── portais/              # msys, ksi, chavesnamao, kenlo (+ index.ts)
│   ├── scrape.ts             # agregador (bun run scrape)
│   ├── store.ts, dedupe.ts   # estado e duplicados entre fontes
│   ├── estado.ts, cli.ts     # CLIs para o Claude e para você
│   ├── server.ts             # servidor local (127.0.0.1)
│   └── exportar.ts           # versão estática para o GitHub Pages
├── web/                      # interface (HTML/CSS/JS puro)
├── .github/workflows/        # pagina.yml: testes + busca + deploy no Pages
├── .claude/commands/         # /scrape /avaliar /contato /add-portal
├── docs/portais.md           # endpoints e âncoras de parsing
├── tests/                    # testes + fixtures (páginas reais em gzip)
└── data/                     # imoveis.json, avaliações (fora do git)
```

`data/` fica fora do controle de versão: contém telefones de corretores e suas anotações pessoais.
