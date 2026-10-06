// Estado da busca em data/imoveis.json: todos os anúncios já vistos, com status do seu
// funil (novo -> interesse -> contatado -> visita -> proposta / descartado), notas,
// histórico de preço e anotações da IA. Escrita atômica + trava de arquivo, porque o
// servidor web e o agregador (ou o Claude via src/estado.ts) podem escrever ao mesmo tempo.

import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "./lib/config.ts"
import type { Imovel } from "./lib/types.ts"
import { computeTotal, dedupeContatos, uniq } from "./lib/text.ts"

export const STATE_PATH = join(DATA_DIR, "imoveis.json")
const LOCK_PATH = join(DATA_DIR, "imoveis.lock")

export type Status = "novo" | "interesse" | "contatado" | "visita" | "proposta" | "descartado"
export const STATUSES: Status[] = ["novo", "interesse", "contatado", "visita", "proposta", "descartado"]

export interface AnotacaoIA {
  nota: number | null
  resumo: string
  alertas: string[]
  data: string
}

export interface Registro extends Imovel {
  chave: string
  primeira_vez: string
  ultima_vez: string
  ativo: boolean
  inativo_desde: string | null
  historico_precos: Array<{ data: string; aluguel: number | null; total: number | null }>
  /** Id do grupo de duplicados (mesmo imóvel em várias fontes); null se único. */
  grupo: string | null
  status: Status
  status_em: string | null
  notas: string
  ia: AnotacaoIA | null
}

export interface ResumoFonte {
  ok: boolean
  encontrados: number
  novos: number
  atualizados: number
  removidos: number
  detalhados: number
  erro: string | null
  avisos: string[]
  ms: number
}

export interface Execucao {
  id: string
  inicio: string
  fim: string | null
  fontes: Record<string, ResumoFonte>
  novos: string[]
}

export interface Estado {
  versao: 1
  atualizado_em: string | null
  imoveis: Record<string, Registro>
  execucoes: Execucao[]
}

export function emptyState(): Estado {
  return { versao: 1, atualizado_em: null, imoveis: {}, execucoes: [] }
}

export function keyOf(im: Pick<Imovel, "fonte" | "id">): string {
  return `${im.fonte}:${im.id}`
}

export function readState(path = STATE_PATH): Estado {
  if (!existsSync(path)) return emptyState()
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Estado
    if (!s || typeof s !== "object" || !s.imoveis) return emptyState()
    s.execucoes ??= []
    return s
  } catch (e) {
    throw new Error(`data/imoveis.json corrompido (${(e as Error).message}) - restaure um backup ou apague o arquivo`)
  }
}

/** Escreve em arquivo temporário e renomeia: um leitor nunca vê JSON pela metade. */
export function writeState(s: Estado, path = STATE_PATH): void {
  mkdirSync(DATA_DIR, { recursive: true })
  s.atualizado_em = new Date().toISOString()
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 1), "utf8")
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path)
      return
    } catch (e) {
      // No Windows o rename falha se outro processo está lendo o arquivo naquele instante.
      if (i >= 20) throw e
      Bun.sleepSync(50)
    }
  }
}

async function acquireLock(timeoutMs = 30_000): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      closeSync(openSync(LOCK_PATH, "wx"))
      return
    } catch {
      try {
        // Trava órfã (processo morreu no meio): mais velha que 2 minutos é descartada.
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > 120_000) unlinkSync(LOCK_PATH)
      } catch {
        /* sumiu entre as chamadas: tenta de novo */
      }
      if (Date.now() - start > timeoutMs) throw new Error("não consegui travar data/imoveis.json (outro processo escrevendo?)")
      await Bun.sleep(50 + Math.random() * 50)
    }
  }
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH)
  } catch {
    /* já liberada */
  }
}

/** Lê, aplica `fn` e grava - tudo sob a trava. */
export async function updateState<T>(fn: (s: Estado) => T | Promise<T>): Promise<T> {
  await acquireLock()
  try {
    const s = readState()
    const r = await fn(s)
    writeState(s)
    return r
  } finally {
    releaseLock()
  }
}

/** Campos que só a página de detalhe traz - não são apagados por uma listagem sem eles. */
const DETAIL_FIELDS: Array<keyof Imovel> = [
  "descricao", "condominio", "iptu", "lat", "lng", "coord_aprox", "suites", "vagas", "area",
  "referencia", "publicado_em", "caracteristicas", "garantias", "contatos", "fotos",
  "mobiliado", "aceita_pet", "anunciante", "endereco",
]

function isEmpty(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === ""
}

/** Mescla dados novos de um anúncio com o que já sabemos dele. */
export function mergeImovel(prev: Registro, next: Imovel): Registro {
  const out: Registro = { ...prev }
  for (const [k, v] of Object.entries(next) as Array<[keyof Imovel, unknown]>) {
    if (isEmpty(v) && DETAIL_FIELDS.includes(k) && !isEmpty(prev[k])) continue
    if (k === "fotos" && Array.isArray(v) && Array.isArray(prev.fotos) && v.length < prev.fotos.length) continue
    if (k === "detalhado") continue
    ;(out as any)[k] = v
  }
  // A listagem só conhece o contato geral da imobiliária; o detalhe traz o corretor.
  // Unimos (detalhe primeiro) para uma nova varredura não apagar o corretor.
  if (prev.detalhado && !next.detalhado) {
    out.contatos = dedupeContatos([...(prev.contatos ?? []), ...(next.contatos ?? [])])
    out.caracteristicas = uniq([...(prev.caracteristicas ?? []), ...(next.caracteristicas ?? [])])
  }
  // Coordenadas andam juntas com a flag de aproximação.
  if (next.lat == null || next.lng == null) {
    out.lat = prev.lat
    out.lng = prev.lng
    out.coord_aprox = prev.coord_aprox
  }
  out.detalhado = prev.detalhado || next.detalhado
  // A listagem costuma mandar total = aluguel (não conhece as taxas); o condomínio/IPTU que o
  // detalhe já trouxe continuam valendo. O maior dos dois é o custo real mais completo.
  const calculado = computeTotal(out.aluguel, out.condominio, out.iptu)
  out.total = out.aluguel == null ? null : Math.max(next.total ?? 0, calculado ?? 0) || null
  return out
}

export interface MergeResult {
  novos: string[]
  atualizados: number
  removidos: number
}

/**
 * Aplica o resultado de uma busca de UMA fonte ao estado. Anúncios que sumiram só são
 * marcados como inativos quando a busca foi completa (todas as páginas lidas).
 */
export function applyResults(s: Estado, fonteId: string, imoveis: Imovel[], completo: boolean, now: string): MergeResult {
  const res: MergeResult = { novos: [], atualizados: 0, removidos: 0 }
  const vistos = new Set<string>()
  const hoje = now.slice(0, 10)
  for (const im of imoveis) {
    const chave = keyOf(im)
    vistos.add(chave)
    const prev = s.imoveis[chave]
    if (!prev) {
      s.imoveis[chave] = {
        ...im,
        chave,
        primeira_vez: now,
        ultima_vez: now,
        ativo: true,
        inativo_desde: null,
        historico_precos: [{ data: hoje, aluguel: im.aluguel, total: im.total }],
        grupo: null,
        status: "novo",
        status_em: null,
        notas: "",
        ia: null,
      }
      res.novos.push(chave)
      continue
    }
    const merged = mergeImovel(prev, im)
    merged.ultima_vez = now
    merged.ativo = true
    merged.inativo_desde = null
    const last = prev.historico_precos.at(-1)
    if (!last || last.aluguel !== merged.aluguel) {
      merged.historico_precos = [...prev.historico_precos, { data: hoje, aluguel: merged.aluguel, total: merged.total }].slice(-20)
    }
    s.imoveis[chave] = merged
    res.atualizados++
  }
  if (completo) {
    for (const r of Object.values(s.imoveis)) {
      if (r.fonte !== fonteId || vistos.has(r.chave) || !r.ativo) continue
      r.ativo = false
      r.inativo_desde = now
      res.removidos++
    }
  }
  return res
}

export function setStatus(s: Estado, chave: string, status: Status): Registro {
  const r = s.imoveis[chave]
  if (!r) throw new Error(`anúncio não encontrado: ${chave}`)
  if (!STATUSES.includes(status)) throw new Error(`status inválido: ${status} (use ${STATUSES.join(", ")})`)
  r.status = status
  r.status_em = new Date().toISOString()
  return r
}
