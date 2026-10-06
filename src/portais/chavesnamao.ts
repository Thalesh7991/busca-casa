// Adaptador Chaves na Mão (chavesnamao.com.br) - portal agregador. Em Botucatu reúne
// anúncios de imobiliárias sem site raspável (RE/MAX Invest, L4S, Daiane Bonan, ADM,
// Cecília Barros...) além de parte do estoque das que já raspamos direto.
// Detalhes em docs/portais.md#chaves-na-mao.
//
// robots.txt: páginas sem query string são permitidas, e query só `?pg=2..5`. Por isso a
// busca percorre as páginas 1-5 de cada tipo residencial e filtra o preço do lado de cá.
//
// Busca:   GET /{tipo}-para-alugar/{uf}-{cidade}/[?pg=N] -> JSON-LD RealEstateListing
//          com offers.itemListElement (15 anúncios por página)
// Detalhe: GET /imovel/.../id-N/ -> JSON-LD (descrição, fotos, anunciante e telefone) e o
//          payload do Next.js (referência, condomínio, IPTU, WhatsApp, CRECI, vagas...)

import type { Contato, DetailRef, Fonte, Imovel, Portal, SearchOptions, SearchResult, Tipo } from "../lib/types.ts"
import { emptyImovel } from "../lib/types.ts"
import { getHtml } from "../lib/http.ts"
import {
  cleanMultiline,
  computeTotal,
  dedupeContatos,
  fixUpperCase,
  inferGarantias,
  inferMobiliado,
  inferPet,
  inline,
  makeContato,
  mapTipo,
  parseBRL,
  parseCoord,
  parseIntOrNull,
  parseJsonLd,
  slugify,
  uniq,
} from "../lib/text.ts"

const MAX_PAGINAS_ROBOTS = 5
const POR_PAGINA = 15

const PATHS: Array<{ path: string; tipos: Tipo[] }> = [
  { path: "apartamentos-para-alugar", tipos: ["apartamento", "flat"] },
  { path: "kitnet-para-alugar", tipos: ["kitnet", "studio"] },
  { path: "casas-para-alugar", tipos: ["casa", "sobrado"] },
  { path: "casas-em-condominio-para-alugar", tipos: ["casa_condominio"] },
  { path: "coberturas-para-alugar", tipos: ["cobertura"] },
]

function baseUrl(fonte: Fonte): string {
  return fonte.url.replace(/\/+$/, "")
}

/** Ofertas do JSON-LD da listagem -> Imovel. Exportado para os testes. */
export function parseListPage(html: string, fonte: Fonte, citySlug: string): { imoveis: Imovel[]; total: number | null } {
  const lista = parseJsonLd(html).find((x) => x?.["@type"] === "RealEstateListing" && x?.offers?.itemListElement)
  if (!lista) return { imoveis: [], total: null }
  const total = typeof lista.offers.numberOfItems === "number" ? lista.offers.numberOfItems : null
  const imoveis: Imovel[] = []
  for (const it of lista.offers.itemListElement as any[]) {
    const url: string = it?.url ?? it?.itemOffered?.["@id"] ?? ""
    const id = url.match(/\/id-(\d+)\/?/)?.[1]
    // A página completa a lista com anúncios "relacionados" de outros tipos/cidades.
    if (!id || !url.includes("-para-alugar-") || !url.includes(`-${citySlug}-`)) continue
    const tipoSlug = url.match(/\/imovel\/([a-z-]+?)-para-alugar-/)?.[1] ?? ""
    const o = it.itemOffered ?? {}
    const regiao = String(o.address?.addressRegion ?? "")
    const [cidade, uf] = regiao.split(",").map((s: string) => s.trim())
    const aluguel = parseBRL(it.price)
    const area = parseBRL(o.floorSize?.value ?? o.floorSize?.unitText)
    const anunciante = inline(it.offeredBy?.name)
    imoveis.push({
      ...emptyImovel({ id, fonte: fonte.id, plataforma: "chavesnamao", url, titulo: inline(it.name) ?? `Anúncio ${id}` }),
      anunciante: fixUpperCase(anunciante),
      tipo: mapTipo(tipoSlug.replace(/-/g, " ")),
      aluguel,
      total: aluguel,
      quartos: parseIntOrNull(o.numberOfBedrooms),
      banheiros: parseIntOrNull(o.numberOfBathroomsTotal),
      vagas: /com-garagem/.test(url) ? null : 0,
      area: area && area > 1 ? area : null,
      bairro: fixUpperCase(o.address?.addressLocality),
      cidade: cidade || null,
      uf: uf || null,
      fotos: uniq([o.image].flat()),
    })
  }
  return { imoveis, total }
}

async function search(fonte: Fonte, opts: SearchOptions): Promise<SearchResult> {
  const base = baseUrl(fonte)
  const citySlug = `${opts.uf.toLowerCase()}-${slugify(opts.cidade)}`
  const wanted = opts.tipos?.length ? opts.tipos : null
  const paths = PATHS.filter((p) => !wanted || p.tipos.some((t) => wanted.includes(t)))
  const maxPaginas = Math.min(opts.maxPaginas ?? MAX_PAGINAS_ROBOTS, MAX_PAGINAS_ROBOTS)

  const byId = new Map<string, Imovel>()
  const avisos: string[] = []
  let completo = true
  let totalGeral = 0

  for (const { path } of paths) {
    let totalPath: number | null = null
    let lidos = 0
    for (let pg = 1; pg <= maxPaginas; pg++) {
      const url = `${base}/${path}/${citySlug}/${pg > 1 ? `?pg=${pg}` : ""}`
      const html = await getHtml(url, { signal: opts.signal })
      if (!html) break
      const { imoveis, total } = parseListPage(html, fonte, citySlug)
      if (pg === 1) totalPath = total
      for (const im of imoveis) {
        if (!byId.has(im.id)) byId.set(im.id, im)
        lidos++
      }
      opts.log?.(`${fonte.id}: ${path} p${pg} - ${byId.size} anúncios`)
      if (totalPath == null || pg * POR_PAGINA >= totalPath || imoveis.length === 0) break
    }
    if (totalPath != null) {
      totalGeral += totalPath
      if (totalPath > maxPaginas * POR_PAGINA) {
        completo = false
        avisos.push(
          `Chaves na Mão: ${path} tem ${totalPath} anúncios, mas o robots.txt só permite ler ${maxPaginas * POR_PAGINA} (5 páginas)`,
        )
      }
    }
  }

  // Preço filtrado aqui: o site só aceita filtros via query string, que o robots.txt proíbe.
  const imoveis = [...byId.values()].filter((im) => opts.aluguelMax == null || im.aluguel == null || im.aluguel <= opts.aluguelMax)
  return { imoveis, total: totalGeral || null, completo, avisos }
}

/** Valor de um campo no payload RSC do Next.js (JSON escapado dentro de strings JS). */
function rscField(unescaped: string, key: string): string | null {
  const m = unescaped.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*"|-?[\\d.]+|true|false|null)`))
  if (!m) return null
  const raw = m[1]
  if (raw.startsWith('"')) {
    const v = raw.slice(1, -1)
    return v === "$undefined" || v === "" ? null : v
  }
  return raw
}

function rscCount(unescaped: string, key: string): number | null {
  const m = unescaped.match(new RegExp(`"${key}":\\{"count":(\\d+)`))
  return m ? Number(m[1]) : null
}

/** Página de detalhe -> campos adicionais. Exportado para os testes. */
export function parseDetailPage(html: string, fonte: Fonte): Partial<Imovel> {
  const ld = parseJsonLd(html).find((x) => x?.["@type"] === "RealEstateListing" && x?.about)
  const about = ld?.about ?? {}
  const offer = about.offers ?? {}
  const item = offer.itemOffered ?? {}
  const agent = offer.offeredBy ?? {}
  const u = html.replace(/\\"/g, '"')

  const referencia = rscField(u, "reference")
  const condominio = parseBRL(rscField(u, "condominiumFee"))
  const iptu = parseBRL(rscField(u, "iptuValue"))
  const aluguel = parseBRL(offer.price)
  const petFriendly = rscField(u, "petFriendly")
  const creci = rscField(u, "creci")
  const whatsList = u.match(/"whatsapp":\[((?:"[^"]*",?)*)\]/)?.[1]
  const whats = whatsList ? [...whatsList.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
  const descricao = cleanMultiline(ld?.description ?? offer.description)

  const anunciante = fixUpperCase(agent.name)
  const contatos: Contato[] = []
  for (const w of whats) {
    contatos.push(makeContato({ nome: anunciante, papel: "anunciante", creci }, w, { whatsapp: w, whatsappExplicito: true }))
  }
  if (agent.telephone) contatos.push(makeContato({ nome: anunciante, papel: "anunciante", creci }, agent.telephone))

  // Centro do bairro (o portal não publica a posição do imóvel) - marcado como aproximado.
  const geo = u.match(/"neighborhood":\{"id":\d+,"name":"[^"]*","url":"[^"]*","geoposition":\{"lon":"(-?[\d.]+)","lat":"(-?[\d.]+)"/)
  const lat = geo ? parseCoord(geo[2]) : parseCoord(item.geo?.latitude)
  const lng = geo ? parseCoord(geo[1]) : parseCoord(item.geo?.longitude)

  const amenities: string[] = Array.isArray(item.amenityFeature)
    ? item.amenityFeature.filter((a: any) => a?.value !== false).map((a: any) => inline(a?.name)).filter(Boolean)
    : []
  const mobiliado = amenities.some((a) => /mobiliad/i.test(a)) ? true : inferMobiliado(descricao)
  const aceita_pet = petFriendly === "true" || item.petsAllowed === true ? true : inferPet(descricao)

  const out: Partial<Imovel> = {
    anunciante,
    referencia,
    aluguel,
    condominio: condominio && condominio > 0 ? condominio : null,
    iptu: iptu && iptu > 0 ? iptu : null,
    quartos: rscCount(u, "bedrooms") ?? parseIntOrNull(item.numberOfBedrooms),
    suites: rscCount(u, "suites"),
    banheiros: rscCount(u, "bathrooms") ?? parseIntOrNull(item.numberOfBathroomsTotal),
    vagas: rscCount(u, "garages"),
    descricao,
    caracteristicas: uniq(amenities),
    mobiliado,
    aceita_pet,
    garantias: inferGarantias(descricao),
    contatos: dedupeContatos(contatos),
    publicado_em: typeof ld?.datePosted === "string" ? ld.datePosted : null,
    atualizado_em: typeof ld?.dateModified === "string" ? ld.dateModified : null,
    lat,
    lng,
    coord_aprox: lat != null,
    detalhado: true,
  }
  const fotos = uniq(Array.isArray(about.image) ? about.image : about.image ? [about.image] : [])
  if (fotos.length) out.fotos = fotos
  const area = parseBRL(rscField(u, "useful")) ?? parseBRL(rscField(u, "total"))
  if (area && area > 1) out.area = area
  out.total = computeTotal(aluguel, out.condominio ?? null, out.iptu ?? null)
  for (const k of Object.keys(out) as Array<keyof Imovel>) if (out[k] == null) delete out[k]
  return out
}

async function detail(fonte: Fonte, ref: DetailRef, opts: { signal?: AbortSignal } = {}): Promise<Partial<Imovel>> {
  const html = await getHtml(ref.url, { signal: opts.signal })
  if (!html) throw new Error("anúncio não encontrado (pode ter sido alugado)")
  return parseDetailPage(html, fonte)
}

export const chavesnamao: Portal = {
  plataforma: "chavesnamao",
  descricao: "Portal Chaves na Mão (agregador; JSON-LD nas listagens, até 5 páginas por tipo)",
  search,
  detail,
}
