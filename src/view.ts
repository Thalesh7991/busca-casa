// Representações compactas dos anúncios para o terminal e para o Claude (que nunca deve
// ler data/imoveis.json inteiro - só o recorte que precisa, via src/estado.ts).

import type { Estado, Registro } from "./store.ts"
import { normalizeBairro } from "./lib/text.ts"
import type { Config } from "./lib/config.ts"

export function brl(v: number | null | undefined): string {
  if (v == null) return "—"
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

/** Primeiro contato útil: WhatsApp de corretor > WhatsApp da imobiliária > telefone. */
export function melhorContato(r: Registro): { nome: string | null; telefone: string | null; whatsapp: string | null } | null {
  const cs = r.contatos ?? []
  const c = cs.find((x) => x.whatsapp && x.papel === "corretor") ?? cs.find((x) => x.whatsapp) ?? cs.find((x) => x.telefone) ?? cs[0]
  return c ? { nome: c.nome, telefone: c.telefone, whatsapp: c.whatsapp } : null
}

export interface Compacto {
  chave: string
  titulo: string
  tipo: string
  aluguel: number | null
  condominio: number | null
  iptu: number | null
  total: number | null
  quartos: number | null
  banheiros: number | null
  vagas: number | null
  area: number | null
  bairro: string | null
  anunciante: string | null
  mobiliado: boolean | null
  aceita_pet: boolean | null
  garantias: string[]
  contato: ReturnType<typeof melhorContato>
  url: string
  status: string
  status_em: string | null
  notas: string
  primeira_vez: string
  grupo: string | null
  tambem_em: string[]
  descricao: string | null
  ia: Registro["ia"]
}

export function compact(r: Registro, s?: Estado, maxDescricao = 700): Compacto {
  const tambem_em = s && r.grupo
    ? Object.values(s.imoveis).filter((x) => x.grupo === r.grupo && x.chave !== r.chave).map((x) => `${x.fonte}:${x.url}`)
    : []
  const d = r.descricao ?? null
  return {
    chave: r.chave,
    titulo: r.titulo,
    tipo: r.tipo,
    aluguel: r.aluguel,
    condominio: r.condominio,
    iptu: r.iptu,
    total: r.total,
    quartos: r.quartos,
    banheiros: r.banheiros,
    vagas: r.vagas,
    area: r.area,
    bairro: r.bairro,
    anunciante: r.anunciante,
    mobiliado: r.mobiliado,
    aceita_pet: r.aceita_pet,
    garantias: r.garantias,
    contato: melhorContato(r),
    url: r.url,
    status: r.status,
    status_em: r.status_em,
    notas: r.notas.length > 400 ? "…" + r.notas.slice(-400) : r.notas,
    primeira_vez: r.primeira_vez,
    grupo: r.grupo,
    tambem_em,
    descricao: d && d.length > maxDescricao ? d.slice(0, maxDescricao) + "…" : d,
    ia: r.ia,
  }
}

export function table(rows: string[][], widths: number[]): string {
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").slice(0, widths[i]).padEnd(widths[i])).join("  ")
  const [head, ...body] = rows
  return [line(head), "-".repeat(widths.reduce((a, b) => a + b + 2, -2)), ...body.map(line)].join("\n")
}

export function listingTable(regs: Registro[]): string {
  if (!regs.length) return "(nenhum)"
  const rows = [["CHAVE", "TIPO", "ALUGUEL", "TOTAL", "Q", "BAIRRO", "ANUNCIANTE", "CONTATO"]]
  for (const r of regs) {
    const c = melhorContato(r)
    rows.push([
      r.chave,
      r.tipo,
      brl(r.aluguel),
      brl(r.total),
      r.quartos == null ? "—" : String(r.quartos),
      r.bairro ?? "—",
      r.anunciante ?? "—",
      c?.telefone ?? "—",
    ])
  }
  return table(rows, [22, 12, 8, 8, 2, 26, 26, 16])
}

/** Centro de cada bairro, a partir dos anúncios com coordenadas (para o mapa aproximado). */
export function centroidesBairros(regs: Registro[]): Map<string, { lat: number; lng: number }> {
  const acc = new Map<string, { lat: number; lng: number; n: number }>()
  for (const r of regs) {
    if (r.lat == null || r.lng == null) continue
    const b = normalizeBairro(r.bairro)
    if (!b) continue
    const a = acc.get(b) ?? { lat: 0, lng: 0, n: 0 }
    a.lat += r.lat
    a.lng += r.lng
    a.n++
    acc.set(b, a)
  }
  const out = new Map<string, { lat: number; lng: number }>()
  for (const [b, a] of acc) out.set(b, { lat: a.lat / a.n, lng: a.lng / a.n })
  return out
}

/** Parte da config que a interface web usa (sem caminhos nem parâmetros internos). */
export function configPublica(c: Config) {
  return {
    cidade: c.cidade,
    uf: c.uf,
    aluguel_max: c.aluguel_max,
    tipos: c.tipos,
    quartos_min: c.quartos_min,
    mensagem_whatsapp: c.mensagem_whatsapp,
    atualizar_a_cada_horas: c.atualizar_a_cada_horas,
    fontes: c.fontes.map((f) => ({ id: f.id, nome: f.nome, plataforma: f.plataforma, url: f.url, ativo: f.ativo, aviso: f.aviso ?? null })),
    busca_manual: c.busca_manual,
  }
}

/** Preenche coordenadas aproximadas (centro do bairro) só na resposta - o estado fica intacto. */
export function comCoordenadas(regs: Registro[]): Registro[] {
  const centros = centroidesBairros(regs)
  return regs.map((r) => {
    if (r.lat != null && r.lng != null) return r
    const c = centros.get(normalizeBairro(r.bairro))
    return c ? { ...r, lat: c.lat, lng: c.lng, coord_aprox: true } : r
  })
}

/** O que a interface carrega: GET /api/dados no servidor local, dados.json na página publicada. */
export function dadosInterface(s: Estado, config: Config) {
  return {
    config: configPublica(config),
    atualizado_em: s.atualizado_em,
    imoveis: comCoordenadas(Object.values(s.imoveis)),
    execucoes: s.execucoes.slice(-10),
  }
}
