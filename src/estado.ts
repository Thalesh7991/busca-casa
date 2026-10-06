// Consultas e escritas pontuais no estado, para o Claude (e para você no terminal) sem
// carregar data/imoveis.json inteiro - o arquivo cresce a cada busca, e os comandos só
// precisam do recorte que vão analisar. Espelha o tools/rank_state.py do ai-job-search.
//
//   bun run estado resumo
//   bun run estado estatisticas                 # mediana de aluguel por tipo/quartos (referência de mercado)
//   bun run estado listar [--status novo] [--novos] [--sem-ia] [--limite 20] [--format json|table]
//   bun run estado ver <chave>
//   bun run estado anotar <chave> --nota 0-100 --resumo "..." [--alerta "..."]...
//   bun run estado status <chave> <novo|interesse|contatado|visita|proposta|descartado>
//   bun run estado nota <chave> "texto"          # acrescenta às suas notas do anúncio

import { STATUSES, readState, setStatus, updateState, type Registro, type Status } from "./store.ts"
import { compact, listingTable } from "./view.ts"

interface Args {
  _: string[]
  flags: Record<string, string | boolean>
  multi: Record<string, string[]>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, multi: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[k] = next
        ;(out.multi[k] ??= []).push(next)
        i++
      } else out.flags[k] = true
    } else out._.push(a)
  }
  return out
}

function fail(msg: string, code = "BAD_ARG"): number {
  console.error(JSON.stringify({ error: msg, code }))
  return 1
}

const USO = `uso:
  bun run estado resumo
  bun run estado estatisticas
  bun run estado listar [--status s] [--novos] [--sem-ia] [--ativos|--todos] [--limite n] [--format json|table]
  bun run estado ver <chave>
  bun run estado anotar <chave> --nota 0-100 --resumo "..." [--alerta "..."]...
  bun run estado status <chave> <${STATUSES.join("|")}>
  bun run estado nota <chave> "texto"`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  const fmt = args.flags.format === "table" ? "table" : "json"

  if (!cmd || args.flags.help) {
    console.log(USO)
    return cmd ? 0 : 1
  }

  if (cmd === "resumo") {
    const s = readState()
    const regs = Object.values(s.imoveis)
    const ativos = regs.filter((r) => r.ativo)
    const porStatus: Record<string, number> = {}
    for (const r of ativos) porStatus[r.status] = (porStatus[r.status] ?? 0) + 1
    const porFonte: Record<string, number> = {}
    for (const r of ativos) porFonte[r.fonte] = (porFonte[r.fonte] ?? 0) + 1
    const ultima = s.execucoes.at(-1)
    console.log(
      JSON.stringify(
        {
          total: regs.length,
          ativos: ativos.length,
          por_status: porStatus,
          por_fonte: porFonte,
          sem_ia: ativos.filter((r) => !r.ia && r.status !== "descartado").length,
          grupos_duplicados: new Set(ativos.map((r) => r.grupo).filter(Boolean)).size,
          ultima_busca: ultima ? { inicio: ultima.inicio, fim: ultima.fim, novos: ultima.novos.length } : null,
        },
        null,
        1,
      ),
    )
    return 0
  }

  if (cmd === "listar") {
    const s = readState()
    const ultima = s.execucoes.at(-1)
    const novosUltima = new Set(ultima?.novos ?? [])
    let regs: Registro[] = Object.values(s.imoveis)
    if (!args.flags.todos) regs = regs.filter((r) => r.ativo)
    if (typeof args.flags.status === "string") {
      if (!STATUSES.includes(args.flags.status as Status)) return fail(`status inválido: ${args.flags.status}`)
      regs = regs.filter((r) => r.status === args.flags.status)
    }
    if (args.flags.novos) regs = regs.filter((r) => novosUltima.has(r.chave))
    if (args.flags["sem-ia"]) regs = regs.filter((r) => !r.ia && r.status !== "descartado")
    // Um anúncio por grupo de duplicados (o principal), para não avaliar o mesmo imóvel 2x.
    const vistos = new Set<string>()
    regs = regs
      .sort((a, b) => (b.primeira_vez ?? "").localeCompare(a.primeira_vez ?? "") || (a.aluguel ?? 1e9) - (b.aluguel ?? 1e9))
      .filter((r) => {
        if (!r.grupo) return true
        if (vistos.has(r.grupo)) return false
        vistos.add(r.grupo)
        return true
      })
    const total = regs.length
    const limite = typeof args.flags.limite === "string" ? Number(args.flags.limite) : 0
    if (limite > 0) regs = regs.slice(0, limite)
    if (fmt === "table") console.log(listingTable(regs))
    else console.log(JSON.stringify({ total, mostrando: regs.length, imoveis: regs.map((r) => compact(r, s)) }, null, 1))
    return 0
  }

  if (cmd === "estatisticas") {
    // Referência de mercado para a triagem: mediana e quartis por tipo e nº de quartos.
    const s = readState()
    const familia: Record<string, string> = { kitnet: "kitnet/studio", studio: "kitnet/studio", apartamento: "apartamento", cobertura: "apartamento", flat: "apartamento", casa: "casa", sobrado: "casa", casa_condominio: "casa em condomínio" }
    const grupos = new Map<string, { aluguel: number[]; m2: number[] }>()
    const vistos = new Set<string>()
    for (const r of Object.values(s.imoveis)) {
      if (!r.ativo || r.aluguel == null) continue
      if (r.grupo) {
        if (vistos.has(r.grupo)) continue
        vistos.add(r.grupo)
      }
      const k = `${familia[r.tipo] ?? r.tipo} · ${r.quartos == null ? "?" : r.quartos >= 3 ? "3+" : r.quartos} quartos`
      const g = grupos.get(k) ?? { aluguel: [], m2: [] }
      g.aluguel.push(r.aluguel)
      if (r.area && r.area > 5) g.m2.push(r.aluguel / r.area)
      grupos.set(k, g)
    }
    const q = (xs: number[], p: number) => {
      if (!xs.length) return null
      const s2 = [...xs].sort((a, b) => a - b)
      const i = (s2.length - 1) * p
      const lo = Math.floor(i)
      return Math.round((s2[lo] + (s2[Math.ceil(i)] - s2[lo]) * (i - lo)) * 100) / 100
    }
    const out = [...grupos.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, g]) => ({ grupo: k, n: g.aluguel.length, p25: q(g.aluguel, 0.25), mediana: q(g.aluguel, 0.5), p75: q(g.aluguel, 0.75), mediana_m2: q(g.m2, 0.5) }))
    console.log(JSON.stringify({ observacao: "só anúncios ativos, um por grupo de duplicados, dentro do filtro de preço da config", grupos: out }, null, 1))
    return 0
  }

  if (cmd === "ver") {
    const chave = args._[1]
    if (!chave) return fail("informe a chave (ex.: sai:8061)")
    const s = readState()
    const r = s.imoveis[chave]
    if (!r) return fail(`anúncio não encontrado: ${chave}`, "NOT_FOUND")
    const mesmoGrupo = r.grupo ? Object.values(s.imoveis).filter((x) => x.grupo === r.grupo && x.chave !== r.chave).map((x) => ({ chave: x.chave, url: x.url, aluguel: x.aluguel, anunciante: x.anunciante })) : []
    console.log(JSON.stringify({ ...r, tambem_em: mesmoGrupo }, null, 1))
    return 0
  }

  if (cmd === "anotar") {
    const chave = args._[1]
    if (!chave) return fail("informe a chave")
    const nota = args.flags.nota === undefined ? null : Number(args.flags.nota)
    if (nota != null && (!Number.isFinite(nota) || nota < 0 || nota > 100)) return fail("--nota deve estar entre 0 e 100")
    const resumo = typeof args.flags.resumo === "string" ? args.flags.resumo.trim() : ""
    if (!resumo) return fail('--resumo "..." é obrigatório')
    const alertas = (args.multi.alerta ?? []).map((a) => a.trim()).filter(Boolean)
    try {
      await updateState((s) => {
        const r = s.imoveis[chave]
        if (!r) throw new Error(`anúncio não encontrado: ${chave}`)
        r.ia = { nota: nota == null ? null : Math.round(nota), resumo: resumo.slice(0, 600), alertas: alertas.slice(0, 6), data: new Date().toISOString() }
      })
    } catch (e) {
      return fail((e as Error).message, "NOT_FOUND")
    }
    console.log(JSON.stringify({ ok: true, chave }))
    return 0
  }

  if (cmd === "status") {
    const [chave, status] = [args._[1], args._[2]]
    if (!chave || !status) return fail("uso: bun run estado status <chave> <status>")
    try {
      await updateState((s) => setStatus(s, chave, status as Status))
    } catch (e) {
      return fail((e as Error).message)
    }
    console.log(JSON.stringify({ ok: true, chave, status }))
    return 0
  }

  if (cmd === "nota") {
    const [chave, texto] = [args._[1], args._.slice(2).join(" ")]
    if (!chave || !texto) return fail('uso: bun run estado nota <chave> "texto"')
    try {
      await updateState((s) => {
        const r = s.imoveis[chave]
        if (!r) throw new Error(`anúncio não encontrado: ${chave}`)
        const data = new Date().toLocaleDateString("pt-BR")
        r.notas = [r.notas, `[${data}] ${texto}`].filter(Boolean).join("\n").slice(-5000)
      })
    } catch (e) {
      return fail((e as Error).message, "NOT_FOUND")
    }
    console.log(JSON.stringify({ ok: true, chave }))
    return 0
  }

  return fail(`comando desconhecido: ${cmd}\n${USO}`, "BAD_CMD")
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(JSON.stringify({ error: e instanceof Error ? e.message : String(e), code: "INTERNAL_ERROR" }))
    process.exit(1)
  })
