// Agrupa o mesmo imóvel anunciado em várias fontes (ex.: a Pontes no site próprio e no
// Chaves na Mão, ou o mesmo apartamento com duas imobiliárias). Dois critérios:
//   1. Referência: o agregador informa "anunciante X, ref 770" e a fonte X tem o id 770.
//   2. Atributos: mesmo aluguel, mesmo bairro, mesma família de tipo e quartos/área
//      compatíveis, em fontes diferentes.
// O grupo não apaga nada - só permite à interface mostrar um card com "também em ...".

import type { Fonte, Tipo } from "./lib/types.ts"
import { normalizeBairro, normalizeName } from "./lib/text.ts"
import type { Estado, Registro } from "./store.ts"

const FAMILIA: Record<Tipo, string> = {
  apartamento: "ap",
  kitnet: "ap",
  studio: "ap",
  cobertura: "ap",
  flat: "ap",
  casa: "casa",
  sobrado: "casa",
  casa_condominio: "casa",
  comercial: "com",
  terreno: "ter",
  rural: "rur",
  outro: "?",
}

/** Plataformas agregadoras (anunciam em nome de terceiros). */
export const AGREGADORES = new Set(["chavesnamao"])

/**
 * Union-find que se recusa a juntar dois conjuntos com anúncios da mesma fonte: uma
 * imobiliária não anuncia o mesmo imóvel duas vezes, então isso seria um falso positivo
 * (ex.: várias kitnets iguais no mesmo prédio) contaminando o grupo por transitividade.
 */
class UnionFind {
  private parent = new Map<string, string>()
  private fontes = new Map<string, Set<string>>()
  constructor(fonteDe: Map<string, string>) {
    for (const [chave, fonte] of fonteDe) this.fontes.set(chave, new Set([fonte]))
  }
  find(x: string): string {
    let p = this.parent.get(x) ?? x
    if (p !== x) {
      p = this.find(p)
      this.parent.set(x, p)
    }
    return p
  }
  union(a: string, b: string): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return true
    const fa = this.fontes.get(ra) ?? new Set<string>()
    const fb = this.fontes.get(rb) ?? new Set<string>()
    for (const f of fb) if (fa.has(f)) return false
    this.parent.set(rb, ra)
    for (const f of fb) fa.add(f)
    this.fontes.set(ra, fa)
    return true
  }
}

function normRef(ref: string | null | undefined): string {
  return String(ref ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")
}

/** Descobre qual fonte configurada corresponde ao nome de um anunciante. */
export function resolveFonte(anunciante: string | null, fontes: Fonte[]): string | null {
  const alvo = normalizeName(anunciante)
  if (alvo.length < 3) return null
  for (const f of fontes) {
    if (AGREGADORES.has(f.plataforma)) continue
    for (const nome of [f.nome, ...(f.apelidos ?? [])]) {
      const n = normalizeName(nome)
      if (n.length < 3) continue
      if (n === alvo || (n.length >= 5 && alvo.includes(n)) || (alvo.length >= 5 && n.includes(alvo))) return f.id
    }
  }
  return null
}

function areaCompativel(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(2, 0.04 * Math.max(a, b))
}

function iguaisSeConhecidos(a: number | null, b: number | null): boolean {
  return a == null || b == null || a === b
}

/**
 * true quando dois anúncios de fontes diferentes parecem o mesmo imóvel. Exige área
 * conhecida e compatível nos dois: sem ela, aluguel + bairro + quartos casam unidades
 * diferentes do mesmo prédio (kitnets perto da UNESP são quase todas iguais).
 */
export function mesmoImovel(a: Registro, b: Registro): boolean {
  if (a.fonte === b.fonte) return false
  if (a.aluguel == null || a.aluguel !== b.aluguel) return false
  if (FAMILIA[a.tipo] !== FAMILIA[b.tipo]) return false
  const ba = normalizeBairro(a.bairro)
  if (!ba || ba !== normalizeBairro(b.bairro)) return false
  if (a.area == null || b.area == null || !areaCompativel(a.area, b.area)) return false
  if (a.quartos == null || b.quartos == null || a.quartos !== b.quartos) return false
  if (!iguaisSeConhecidos(a.banheiros, b.banheiros) || !iguaisSeConhecidos(a.vagas, b.vagas)) return false
  if (a.condominio != null && b.condominio != null && Math.abs(a.condominio - b.condominio) > 5) return false
  return true
}

function prioridade(r: Registro): number[] {
  return [
    AGREGADORES.has(r.plataforma) ? 1 : 0,
    r.detalhado ? 0 : 1,
    -r.fotos.length,
    Date.parse(r.primeira_vez) || 0,
  ]
}

function compararPrioridade(a: Registro, b: Registro): number {
  const pa = prioridade(a)
  const pb = prioridade(b)
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return a.chave.localeCompare(b.chave)
}

/** Recalcula `grupo` de todos os anúncios ativos. Devolve quantos grupos existem. */
export function assignGroups(s: Estado, fontes: Fonte[]): number {
  const ativos = Object.values(s.imoveis).filter((r) => r.ativo)
  const uf = new UnionFind(new Map(ativos.map((r) => [r.chave, r.fonte])))

  // 1. Referência informada pelo agregador -> anúncio da fonte direta.
  const porRef = new Map<string, string>()
  for (const r of ativos) {
    if (AGREGADORES.has(r.plataforma) || !r.referencia) continue
    porRef.set(`${r.fonte}#${normRef(r.referencia)}`, r.chave)
  }
  for (const r of ativos) {
    if (!AGREGADORES.has(r.plataforma) || !r.referencia) continue
    const fonte = resolveFonte(r.anunciante, fontes)
    const alvo = fonte ? porRef.get(`${fonte}#${normRef(r.referencia)}`) : undefined
    if (alvo) uf.union(alvo, r.chave)
  }

  // 2. Atributos, comparando só dentro do mesmo valor de aluguel.
  const porPreco = new Map<number, Registro[]>()
  for (const r of ativos) {
    if (r.aluguel == null) continue
    const lista = porPreco.get(r.aluguel) ?? []
    lista.push(r)
    porPreco.set(r.aluguel, lista)
  }
  for (const lista of porPreco.values()) {
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        if (mesmoImovel(lista[i], lista[j])) uf.union(lista[i].chave, lista[j].chave)
      }
    }
  }

  const grupos = new Map<string, Registro[]>()
  for (const r of ativos) {
    const raiz = uf.find(r.chave)
    const g = grupos.get(raiz) ?? []
    g.push(r)
    grupos.set(raiz, g)
  }
  for (const r of Object.values(s.imoveis)) if (!r.ativo) r.grupo = null
  let n = 0
  for (const membros of grupos.values()) {
    if (membros.length < 2) {
      membros[0].grupo = null
      continue
    }
    n++
    const principal = [...membros].sort(compararPrioridade)[0]
    for (const m of membros) m.grupo = `g:${principal.chave}`
  }
  return n
}
