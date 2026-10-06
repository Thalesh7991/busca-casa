// CLI por portal - o equivalente aos `*-search` do ai-job-search: roda a busca ou o
// detalhe de UMA fonte e imprime JSON (padrão), tabela ou texto. Útil para depurar um
// adaptador, para o /add-portal testar um site novo e para o health check.
//
//   bun run portal fontes
//   bun run portal search <fonte> [--max-price 2000] [--pages 2] [--limit 20] [--format json|table|plain]
//   bun run portal search --plataforma msys --site https://nova.imb.br [...]   (site fora da config)
//   bun run portal detail <fonte> <url> [--format json|plain]
//   bun run portal saude [<fonte>...] [--detalhe]

import { loadConfig } from "./lib/config.ts"
import { BlockedError } from "./lib/http.ts"
import type { Fonte, Imovel } from "./lib/types.ts"
import { PORTAIS, getPortal } from "./portais/index.ts"
import { table } from "./view.ts"

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[k] = next
        i++
      } else out.flags[k] = true
    } else out._.push(a)
  }
  return out
}

const KNOWN: Record<string, Set<string>> = {
  fontes: new Set(["format"]),
  search: new Set(["max-price", "pages", "limit", "format", "plataforma", "site", "nome", "cidade", "uf"]),
  detail: new Set(["format", "plataforma", "site"]),
  saude: new Set(["detalhe", "format"]),
}

function fail(msg: string, code = "BAD_ARG"): number {
  console.error(JSON.stringify({ error: msg, code }))
  return 1
}

function intFlag(v: string | boolean | undefined, nome: string): number | undefined | null {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) {
    fail(`--${nome} deve ser um inteiro >= 1`)
    return null
  }
  return n
}

function plain(im: Partial<Imovel>): string {
  const linhas = [
    im.titulo,
    `${im.tipo ?? "?"} · R$ ${im.aluguel ?? "?"}${im.condominio ? ` + cond. ${im.condominio}` : ""}${im.iptu ? ` + IPTU ${im.iptu}` : ""}${im.total ? ` = ${im.total}` : ""}`,
    `${im.quartos ?? "?"} quartos · ${im.banheiros ?? "?"} banh. · ${im.vagas ?? "?"} vagas · ${im.area ?? "?"} m²`,
    `${[im.endereco, im.bairro, im.cidade].filter(Boolean).join(", ")}`,
    im.anunciante ? `Anunciante: ${im.anunciante}${im.referencia ? ` (ref. ${im.referencia})` : ""}` : "",
    ...(im.contatos ?? []).map((c) => `Contato: ${c.nome ?? ""} [${c.papel}] ${c.telefone ?? ""}${c.whatsapp ? ` wa.me/${c.whatsapp}` : ""} ${c.email ?? ""}${c.creci ? ` CRECI ${c.creci}` : ""}`),
    im.caracteristicas?.length ? `Características: ${im.caracteristicas.join(", ")}` : "",
    im.descricao ? `\n${im.descricao}` : "",
    `\n${im.url ?? ""}`,
  ]
  return linhas.filter((l) => l !== "" && l != null).join("\n")
}

function resolveFonte(args: Args, idx: number): Fonte | null {
  const cfg = loadConfig()
  if (typeof args.flags.site === "string" && typeof args.flags.plataforma === "string") {
    const url = args.flags.site.replace(/\/+$/, "")
    return { id: new URL(url).hostname.replace(/^www\./, "").split(".")[0].replace(/[^a-z0-9]/g, ""), nome: typeof args.flags.nome === "string" ? args.flags.nome : new URL(url).hostname, plataforma: args.flags.plataforma, url, ativo: true }
  }
  const id = args._[idx]
  if (!id) return null
  return cfg.fontes.find((f) => f.id === id) ?? null
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (!cmd || args.flags.help) {
    console.log(`uso:
  bun run portal fontes
  bun run portal search <fonte> [--max-price N] [--pages N] [--limit N] [--format json|table|plain]
  bun run portal search --plataforma <${Object.keys(PORTAIS).join("|")}> --site <url> [--nome "..."]
  bun run portal detail <fonte> <url> [--format json|plain]
  bun run portal saude [<fonte>...] [--detalhe]`)
    return cmd ? 0 : 1
  }
  const known = KNOWN[cmd]
  if (!known) return fail(`comando desconhecido: ${cmd}`, "BAD_CMD")
  for (const k of Object.keys(args.flags)) {
    if (!known.has(k)) return fail(`opção desconhecida --${k} para '${cmd}' (opções nunca são ignoradas em silêncio - veja --help)`)
  }
  const cfg = loadConfig()
  const fmt = typeof args.flags.format === "string" ? args.flags.format : "json"

  if (cmd === "fontes") {
    const rows = cfg.fontes.map((f) => ({ id: f.id, nome: f.nome, plataforma: f.plataforma, url: f.url, ativo: f.ativo, aviso: f.aviso ?? null }))
    if (fmt === "table") console.log(table([["ID", "PLATAFORMA", "ATIVO", "NOME"], ...rows.map((r) => [r.id, r.plataforma, r.ativo ? "sim" : "não", r.nome])], [12, 12, 5, 40]))
    else console.log(JSON.stringify(rows, null, 1))
    return 0
  }

  if (cmd === "search") {
    const fonte = resolveFonte(args, 1)
    if (!fonte) return fail("informe uma fonte da config (bun run portal fontes) ou --plataforma + --site")
    const maxPrice = intFlag(args.flags["max-price"], "max-price")
    const pages = intFlag(args.flags.pages, "pages")
    const limit = intFlag(args.flags.limit, "limit")
    if (maxPrice === null || pages === null || limit === null) return 1
    try {
      const r = await getPortal(fonte.plataforma).search(fonte, {
        cidade: typeof args.flags.cidade === "string" ? args.flags.cidade : cfg.cidade,
        uf: typeof args.flags.uf === "string" ? args.flags.uf : cfg.uf,
        aluguelMax: maxPrice ?? cfg.aluguel_max,
        tipos: cfg.tipos,
        maxPaginas: pages ?? cfg.max_paginas,
      })
      const imoveis = limit ? r.imoveis.slice(0, limit) : r.imoveis
      if (fmt === "table") {
        console.log(
          table(
            [["ID", "TIPO", "ALUGUEL", "Q", "BAIRRO", "TÍTULO"], ...imoveis.map((i) => [i.id, i.tipo, String(i.aluguel ?? "—"), String(i.quartos ?? "—"), i.bairro ?? "—", i.titulo])],
            [12, 12, 8, 2, 24, 50],
          ),
        )
        console.log(`\n${r.imoveis.length} anúncios (total na fonte: ${r.total ?? "?"}, completo: ${r.completo ? "sim" : "não"})`)
        for (const a of r.avisos) console.log(`aviso: ${a}`)
      } else if (fmt === "plain") console.log(imoveis.map(plain).join("\n\n----\n\n"))
      else console.log(JSON.stringify({ meta: { fonte: fonte.id, count: imoveis.length, total: r.total, completo: r.completo, avisos: r.avisos }, results: imoveis }, null, 1))
      return 0
    } catch (e) {
      return fail((e as Error).message, e instanceof BlockedError ? "BLOCKED" : "SEARCH_FAILED")
    }
  }

  if (cmd === "detail") {
    const fonte = resolveFonte(args, 1)
    const url = typeof args.flags.site === "string" ? args._[1] : args._[2]
    if (!fonte || !url) return fail("uso: bun run portal detail <fonte> <url>")
    try {
      const d = await getPortal(fonte.plataforma).detail(fonte, { url })
      console.log(fmt === "plain" ? plain({ url, ...d }) : JSON.stringify({ url, ...d }, null, 1))
      return 0
    } catch (e) {
      return fail((e as Error).message, e instanceof BlockedError ? "BLOCKED" : "DETAIL_FAILED")
    }
  }

  if (cmd === "saude") {
    const ids = args._.slice(1)
    const alvo = ids.length ? cfg.fontes.filter((f) => ids.includes(f.id)) : cfg.fontes.filter((f) => f.ativo)
    if (!alvo.length) return fail("nenhuma fonte para testar")
    const out: Array<Record<string, unknown>> = []
    for (const fonte of alvo) {
      const t0 = Date.now()
      const rel: Record<string, unknown> = { fonte: fonte.id, plataforma: fonte.plataforma }
      try {
        const r = await getPortal(fonte.plataforma).search(fonte, { cidade: cfg.cidade, uf: cfg.uf, aluguelMax: cfg.aluguel_max, tipos: cfg.tipos, maxPaginas: 1 })
        const n = r.imoveis.length
        const semPreco = r.imoveis.filter((i) => i.aluguel == null).length
        const lixo = r.imoveis.filter((i) => /&[a-z]+;|<\w+/i.test(i.titulo) || !i.url.startsWith("http")).length
        rel.anuncios_pagina1 = n
        rel.total = r.total
        if (n === 0) rel.veredito = "sem resultados (confira no site - pode ser real ou o parser quebrou)"
        else if (semPreco > n / 2 || lixo > 0) rel.veredito = `degradado (${semPreco} sem preço, ${lixo} com título/URL estranhos)`
        else rel.veredito = "ok"
        if (args.flags.detalhe && n > 0) {
          const d = await getPortal(fonte.plataforma).detail(fonte, { url: r.imoveis[0].url })
          rel.detalhe = d.descricao ? "ok" : "degradado (sem descrição)"
        }
      } catch (e) {
        rel.veredito = e instanceof BlockedError ? "inconclusivo (bloqueado/rate-limit - não é prova de quebra)" : `erro: ${(e as Error).message}`
      }
      rel.ms = Date.now() - t0
      out.push(rel)
    }
    if (fmt === "table") console.log(table([["FONTE", "VEREDITO", "P1", "MS"], ...out.map((o) => [String(o.fonte), String(o.veredito), String(o.anuncios_pagina1 ?? "—"), String(o.ms)])], [12, 60, 4, 6]))
    else console.log(JSON.stringify(out, null, 1))
    return out.every((o) => o.veredito === "ok") ? 0 : 2
  }

  return fail(`comando desconhecido: ${cmd}`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }))
    process.exit(1)
  })
