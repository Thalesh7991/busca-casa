// Agregador: roda todas as fontes ativas em paralelo, filtra pelos critérios da busca,
// lê a página de detalhe só dos anúncios novos (ou ainda não detalhados), mescla no
// estado, agrupa duplicados e registra a execução.
//
//   bun run scrape                      # todas as fontes ativas, saída em tabela
//   bun run scrape --format json        # resumo + novos anúncios em JSON (usado pelo /scrape)
//   bun run scrape --fonte robuste,sai  # só algumas fontes
//   bun run scrape --sem-detalhes       # mais rápido: não abre as páginas dos anúncios
//   bun run scrape --redetalhar         # relê o detalhe de TODOS (após corrigir um adaptador)

import { loadConfig, type Config } from "./lib/config.ts"
import { mapLimit } from "./lib/http.ts"
import { refineTipo, slugify } from "./lib/text.ts"
import type { Fonte, Imovel } from "./lib/types.ts"
import { TIPOS_NAO_RESIDENCIAIS } from "./lib/types.ts"
import { getPortal } from "./portais/index.ts"
import { assignGroups } from "./dedupe.ts"
import { applyResults, keyOf, readState, updateState, type Estado, type Execucao, type ResumoFonte } from "./store.ts"
import { compact, listingTable } from "./view.ts"

export type Fase = "aguardando" | "buscando" | "detalhando" | "ok" | "erro"

export interface ProgressoFonte {
  fonte: string
  nome: string
  fase: Fase
  encontrados: number
  detalhados: number
  paraDetalhar: number
  msg: string | null
}

export interface ScrapeOptions {
  config: Config
  fontes?: string[]
  detalhes?: boolean
  /** Relê a página de detalhe de todos os anúncios, não só dos novos (manutenção). */
  redetalhar?: boolean
  signal?: AbortSignal
  onProgress?: (p: Record<string, ProgressoFonte>) => void
  log?: (msg: string) => void
}

/** Critérios da busca aplicados a um anúncio (depois da busca e de novo após o detalhe). */
export function atendeCriterios(im: Imovel, cfg: Config): boolean {
  im.tipo = refineTipo(im.tipo, im.titulo)
  if (TIPOS_NAO_RESIDENCIAIS.includes(im.tipo)) return false
  if (im.tipo !== "outro" && !cfg.tipos.includes(im.tipo)) return false
  if (im.aluguel != null && im.aluguel > cfg.aluguel_max) return false
  if (cfg.quartos_min > 0 && im.quartos != null && im.quartos < cfg.quartos_min) return false
  if (im.cidade && slugify(im.cidade) !== slugify(cfg.cidade)) return false
  return true
}

function aplicarDetalhe(im: Imovel, d: Partial<Imovel>): void {
  for (const [k, v] of Object.entries(d)) {
    if (v == null || (Array.isArray(v) && v.length === 0)) continue
    ;(im as any)[k] = v
  }
  im.detalhado = true
}

export async function runScrape(o: ScrapeOptions): Promise<{ execucao: Execucao; estado: Estado }> {
  const cfg = o.config
  const detalhes = o.detalhes ?? cfg.buscar_detalhes
  const selecionadas: Fonte[] = cfg.fontes.filter((f) => (o.fontes?.length ? o.fontes.includes(f.id) : f.ativo))
  if (!selecionadas.length) throw new Error("nenhuma fonte ativa selecionada (veja config/busca.json)")

  const snapshot = readState()
  const inicio = new Date().toISOString()
  const progresso: Record<string, ProgressoFonte> = {}
  for (const f of selecionadas) {
    progresso[f.id] = { fonte: f.id, nome: f.nome, fase: "aguardando", encontrados: 0, detalhados: 0, paraDetalhar: 0, msg: null }
  }
  const emit = (id: string, patch: Partial<ProgressoFonte>) => {
    Object.assign(progresso[id], patch)
    o.onProgress?.(structuredClone(progresso))
  }
  emit(selecionadas[0].id, {})

  type Resultado = { fonte: Fonte; imoveis: Imovel[]; completo: boolean; resumo: ResumoFonte }

  const resultados = await mapLimit(selecionadas, cfg.concorrencia, async (fonte): Promise<Resultado> => {
    const t0 = Date.now()
    const resumo: ResumoFonte = { ok: false, encontrados: 0, novos: 0, atualizados: 0, removidos: 0, detalhados: 0, erro: null, avisos: [], ms: 0 }
    try {
      emit(fonte.id, { fase: "buscando", msg: null })
      const portal = getPortal(fonte.plataforma)
      const r = await portal.search(fonte, {
        cidade: cfg.cidade,
        uf: cfg.uf,
        aluguelMax: cfg.aluguel_max,
        tipos: cfg.tipos,
        maxPaginas: cfg.max_paginas,
        signal: o.signal,
        log: o.log,
      })
      let imoveis = r.imoveis.filter((im) => atendeCriterios(im, cfg))
      resumo.avisos.push(...r.avisos)
      emit(fonte.id, { encontrados: imoveis.length })

      if (detalhes) {
        const pendentes = o.redetalhar ? imoveis : imoveis.filter((im) => !snapshot.imoveis[keyOf(im)]?.detalhado)
        emit(fonte.id, { fase: "detalhando", paraDetalhar: pendentes.length })
        let falhas = 0
        await mapLimit(pendentes, 2, async (im) => {
          try {
            aplicarDetalhe(im, await portal.detail(fonte, { url: im.url, id: im.id }, { signal: o.signal }))
            resumo.detalhados++
          } catch (e) {
            falhas++
            if (falhas <= 3) resumo.avisos.push(`detalhe ${im.id}: ${(e as Error).message}`)
          }
          emit(fonte.id, { detalhados: resumo.detalhados + falhas })
        })
        if (falhas > 3) resumo.avisos.push(`... e mais ${falhas - 3} falhas de detalhe`)
        // O detalhe pode revelar preço/tipo/cidade que tiram o anúncio dos critérios.
        imoveis = imoveis.filter((im) => atendeCriterios(im, cfg))
      }

      resumo.ok = true
      resumo.encontrados = imoveis.length
      resumo.ms = Date.now() - t0
      emit(fonte.id, { fase: "ok", encontrados: imoveis.length })
      return { fonte, imoveis, completo: r.completo, resumo }
    } catch (e) {
      resumo.erro = (e as Error).message
      resumo.ms = Date.now() - t0
      emit(fonte.id, { fase: "erro", msg: resumo.erro })
      return { fonte, imoveis: [], completo: false, resumo }
    }
  })

  const fim = new Date().toISOString()
  const execucao: Execucao = { id: inicio, inicio, fim, fontes: {}, novos: [] }
  const estado = await updateState((s) => {
    for (const r of resultados) {
      execucao.fontes[r.fonte.id] = r.resumo
      if (!r.resumo.ok) continue
      const m = applyResults(s, r.fonte.id, r.imoveis, r.completo, inicio)
      r.resumo.novos = m.novos.length
      r.resumo.atualizados = m.atualizados
      r.resumo.removidos = m.removidos
      execucao.novos.push(...m.novos)
    }
    assignGroups(s, cfg.fontes)
    s.execucoes = [...s.execucoes, execucao].slice(-50)
    return s
  })
  return { execucao, estado }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith("--")) {
      out[k] = next
      i++
    } else out[k] = true
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const conhecidas = new Set(["format", "fonte", "sem-detalhes", "redetalhar", "help"])
  for (const k of Object.keys(args)) {
    if (!conhecidas.has(k)) {
      console.error(JSON.stringify({ error: `opção desconhecida --${k} (veja --help)`, code: "BAD_ARG" }))
      return 1
    }
  }
  if (args.help) {
    console.log("uso: bun run scrape [--fonte id1,id2] [--sem-detalhes | --redetalhar] [--format table|json]")
    return 0
  }
  const config = loadConfig()
  const fontes = typeof args.fonte === "string" ? args.fonte.split(",").map((s) => s.trim()).filter(Boolean) : undefined
  if (fontes) {
    const ids = new Set(config.fontes.map((f) => f.id))
    const desconhecidas = fontes.filter((f) => !ids.has(f))
    if (desconhecidas.length) {
      console.error(JSON.stringify({ error: `fonte(s) desconhecida(s): ${desconhecidas.join(", ")}`, code: "BAD_ARG" }))
      return 1
    }
  }
  const json = args.format === "json"
  // Progresso só num terminal interativo (redirecionado vira lixo de \r no log).
  const mostrarProgresso = !json && Boolean(process.stderr.isTTY)
  const { execucao, estado } = await runScrape({
    config,
    fontes,
    detalhes: args["sem-detalhes"] ? false : undefined,
    redetalhar: Boolean(args.redetalhar),
    onProgress: !mostrarProgresso
      ? undefined
      : (p) => {
          const linha = Object.values(p)
            .map((x) => `${x.fonte}:${x.fase === "detalhando" ? `det ${x.detalhados}/${x.paraDetalhar}` : x.fase}`)
            .join("  ")
          process.stderr.write(`\r${linha}`.padEnd(160))
        },
  })
  if (mostrarProgresso) process.stderr.write("\n")

  const novos = execucao.novos.map((k) => estado.imoveis[k]).filter(Boolean)
  if (json) {
    const ativos = Object.values(estado.imoveis).filter((r) => r.ativo)
    console.log(
      JSON.stringify(
        {
          execucao: { inicio: execucao.inicio, fim: execucao.fim, fontes: execucao.fontes },
          totais: { ativos: ativos.length, novos: novos.length },
          novos: novos.map((r) => compact(r, estado)),
        },
        null,
        1,
      ),
    )
  } else {
    console.log("\nFONTES")
    for (const [id, r] of Object.entries(execucao.fontes)) {
      const st = r.ok ? `${r.encontrados} anúncios, ${r.novos} novos, ${r.removidos} saíram, ${r.detalhados} detalhados` : `ERRO: ${r.erro}`
      console.log(`  ${id.padEnd(12)} ${st} (${(r.ms / 1000).toFixed(1)}s)`)
      for (const a of r.avisos) console.log(`  ${"".padEnd(12)} aviso: ${a}`)
    }
    console.log(`\nNOVOS (${novos.length})`)
    console.log(listingTable(novos))
    console.log("\nAbra a interface com: bun run app")
  }
  return Object.values(execucao.fontes).some((r) => r.ok) ? 0 : 1
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }))
      process.exit(1)
    })
}
