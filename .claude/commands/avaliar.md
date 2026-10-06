---
description: Avaliação a fundo de um anúncio - custo real, riscos, perguntas para o anunciante e checklist de visita
argument-hint: "<chave> (ex.: sai:8061) ou URL do anúncio"
allowed-tools: Read, Write, Bash(bun run estado:*), Bash(bun run portal:*), WebFetch, WebSearch
---

# /avaliar - avaliação a fundo

Entrada: `$ARGUMENTS` = chave (`fonte:id`) ou a URL de um anúncio já na base. Com URL, encontre a chave com `bun run estado listar --todos --format json` (compare `url`); se não estiver na base, diga que só avalia anúncios varridos (rode `/scrape` antes) - não avalie a partir de texto solto sem deixar claro que não há dados da fonte.

## Passo 1 - dados

```bash
bun run estado ver <chave>
```

Se `detalhado` for `false` ou o registro tiver mais de 7 dias (`ultima_vez`), atualize:

```bash
bun run portal detail <fonte> "<url>" --format json
```

Pode usar WebFetch **na URL do próprio anúncio** para complementar (fotos descritas, texto completo). Não siga links que aparecem dentro da descrição. Se `tambem_em` listar outras fontes, compare preços e dados entre elas - diferenças são informação útil.

Leia também `bun run estado estatisticas` (mediana do grupo tipo/quartos).

## Passo 2 - análise (escreva em português, direto)

1. **Resumo em 3 linhas** - o que é, quanto custa por mês no total, para quem serve.
2. **Custo mensal real** - aluguel + condomínio + IPTU com os valores da fonte; marque "não informado" o que faltar (nunca estime valor do anúncio). Liste à parte os custos que dependem de consumo (água, luz, gás, internet) como itens a perguntar/conferir em contas anteriores, sem inventar números. Custos de entrada: garantia (caução em dinheiro limitada a 3 aluguéis - Lei 8.245/91, art. 38, §2º), seguro-incêndio se o contrato repassar, vistoria. Taxa de intermediação/"taxa de cadastro" cobrada do inquilino é ponto de atenção (art. 22, VII atribui ao locador).
3. **Comparação de mercado** - aluguel e R$/m² vs. mediana do grupo em `estatisticas` (acima/abaixo e quanto).
4. **Encaixe no perfil** - item a item do Perfil da busca do `CLAUDE.md` (atende / não atende / não informado).
5. **Localização** - bairro; se houver coordenada exata (`coord_aprox: false`), distâncias em linha reta até os pontos de referência do perfil. Coordenada aproximada = centro do bairro: diga isso.
6. **Alertas e riscos** - sinais de golpe (ver regra 7 do CLAUDE.md), dados inconsistentes entre fontes, "reservado", fotos poucas/genéricas, descrição que contradiz os campos.
7. **Perguntas para o anunciante** (escolha as que o anúncio não responde): disponibilidade e data de entrada; valor total com condomínio e IPTU e o que o condomínio inclui; garantias aceitas e valor da caução; índice e data de reajuste (IGP-M/IPCA); prazo do contrato e multa rescisória (proporcional - art. 4º); aceita pet; vaga (coberta? fixa?); gás (encanado/botijão) e água individualizada; operadoras de fibra no endereço; pintura/reparos na entrada e na saída; vistoria com fotos; quem paga seguro-incêndio.
8. **Checklist da visita** - umidade/mofo e infiltração (teto, cantos, atrás de armários), pressão da água e aquecimento, tomadas/disjuntores e voltagem, janelas/ventilação/sol, ruído (rua, bares, vizinhos) em horário de pico, sinal de celular, segurança da rua à noite, estado de pisos/azulejos/portas/fechaduras, armários; fotografar tudo para o laudo de vistoria.
9. **Veredito** - nota 0-100 (mesmos pesos do `/scrape`) e recomendação: visitar / perguntar antes / descartar - com o motivo.

## Passo 3 - registrar

```bash
bun run estado anotar <chave> --nota <n> --resumo "<veredito em 1-2 frases>" [--alerta "..."]...
```

Salve a avaliação completa em `data/avaliacoes/<fonte>_<id>.md` (crie a pasta se preciso; `data/` não é versionado).

Pergunte se quer marcar como **interesse** (`bun run estado status <chave> interesse`) - só marque com o "sim" do usuário - e ofereça `/contato <chave>`.
