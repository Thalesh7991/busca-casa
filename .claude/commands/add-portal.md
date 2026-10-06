---
description: Adiciona uma imobiliária ou portal como fonte - reaproveita um adaptador existente ou cria um novo, sempre respeitando robots.txt
argument-hint: "<url do site da imobiliária ou portal>"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(bun run portal:*), Bash(bun test:*), Bash(bun run typecheck), Bash(curl -s*), WebFetch, WebSearch
---

# /add-portal - nova fonte de anúncios

Entrada: `$ARGUMENTS` = URL da imobiliária/portal. A maioria das imobiliárias usa uma plataforma pronta; se for uma já suportada, basta uma entrada na config.

## Passo 1 - acesso e regras do site

1. Busque `<site>/robots.txt` (`curl -s -A "Mozilla/5.0 (compatible; busca-imoveis/1.0; uso pessoal)" <site>/robots.txt`). Verifique se as páginas de listagem/detalhe (ou a API que a página usa) estão liberadas para `User-agent: *`.
2. Se o robots.txt proíbe, **diga isso ao usuário com clareza** e deixe-o decidir. Se ele quiser seguir para uso pessoal, a fonte entra com `"aviso": "robots.txt proíbe robôs..."` e só com `"ativo": true` se ele pedir. Se não, entra em `busca_manual` com o link já filtrado.
3. Página de bloqueio anti-robô (Cloudflare "Attention Required"/"Just a moment", captcha) ou login obrigatório → **não contorne**. Adicione em `busca_manual` (com `obs`) e pare.

## Passo 2 - identificar a plataforma

Baixe a página de imóveis para alugar da cidade e procure as assinaturas:

| Plataforma | Assinatura no HTML | Adaptador |
|---|---|---|
| msys | `__NEXT_DATA__` com `"imob":"msys_imob_..."`, fotos em `msys-imob-*.s3` | `msys` |
| KSI | `kurole_include`, links `/ksi/`, URLs `/alugar/<Cidade>/<Tipo>/.../<id>` | `ksi` |
| Kenlo | `window.markoVars`, imagens `img.kenlo.io` (robots.txt costuma proibir) | `kenlo` |
| Chaves na Mão | domínio chavesnamao.com.br | `chavesnamao` |

Plataformas vistas em Botucatu e ainda **sem** adaptador: Jetimob (daianebonan.com.br), ImobiBrasil (ceciliabarrosimoveis.com.br), Code49/Midas (corretorarealtors.com.br).

## Passo 3a - plataforma suportada

1. Acrescente em `config/busca.json` → `fontes`: `{ "id": "<curto-sem-acento>", "nome": "<nome da imobiliária>", "plataforma": "<msys|ksi|kenlo>", "url": "<https://site sem barra final>", "ativo": true }`. Se a imobiliária aparece com outro nome no Chaves na Mão, inclua `"apelidos": ["..."]` (é o que liga os duplicados).
2. Teste ao vivo, uma página: `bun run portal search <id> --pages 1 --format table` e `bun run portal detail <id> "<url do 1º resultado>" --format plain`.
3. Confira: preços, quartos, bairro e contato fazem sentido comparando com o site? Então pronto - o próximo `/scrape` já inclui a fonte.

## Passo 3b - plataforma nova

1. Investigue a fonte de dados mais estável, nesta ordem: API JSON que a própria página chama (aba Network - procure `fetch`/`axios` no bundle) → estado embutido (`__NEXT_DATA__`, `window.__INITIAL_STATE__`, markoVars) → JSON-LD (`application/ld+json`) → cards HTML. Descubra filtro de preço e paginação.
2. Crie `src/portais/<plataforma>.ts` implementando `Portal` (`src/lib/types.ts`): `search` devolve `Imovel[]` com todos os campos do contrato (ausente = `null`, nunca omitido), `completo` só `true` se leu todas as páginas; `detail` devolve só os campos que a página acrescenta. Use `getHtml`/`getJson`/`postJson` de `src/lib/http.ts` (User-Agent honesto, espaçamento entre requisições, backoff) e os utilitários de `src/lib/text.ts` (`parseBRL`, `makeContato`, `mapTipo`, `htmlToText`...). Comentário de cabeçalho com os endpoints, como nos adaptadores existentes.
3. Registre em `src/portais/index.ts`, documente endpoints e âncoras de parsing em `docs/portais.md`.
4. Teste offline: salve uma página real em `tests/fixtures/<plataforma>-lista.html.gz` (gzip - `Bun.gzipSync`) e escreva `tests/<plataforma>.test.ts` no padrão dos existentes. Rode `bun test` e `bun run typecheck`.
5. Teste ao vivo (uma página) e adicione a fonte como no Passo 3a.

## Relatório final

```
Fonte adicionada: <nome> (<plataforma>) - <N> anúncios até R$ <max> em <cidade>
robots.txt: <liberado | restritivo - aviso registrado>
Teste: busca ok, detalhe ok (<campos que vieram / faltaram>)
```
