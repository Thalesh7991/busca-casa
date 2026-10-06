// Adaptador msys (msysimob.com.br) - plataforma Next.js usada por várias imobiliárias
// de Botucatu (Robuste, Pontes, Molina, Dupla...). Endpoints e âncoras de parsing em
// docs/portais.md#msys.
//
// Busca: POST {site}/api/service/consult  (o mesmo JSON que a página de listagem envia)
//        -> { response: { numFound, docs: [...] } }  - filtro de preço no servidor (toPrice)
// Site:  GET  {site}/alugar/{cidade-uf}  -> __NEXT_DATA__ com o id interno da cidade e os
//        contatos da imobiliária (imobInfo)
// Detalhe: GET {site}/imovel/{id} (redireciona para a URL canônica) -> __NEXT_DATA__ com
//        descrição, características e o corretor captador (nome, CRECI, telefone, e-mail)

import type { Contato, DetailRef, Fonte, Imovel, Portal, SearchOptions, SearchResult } from "../lib/types.ts"
import { emptyImovel } from "../lib/types.ts"
import { getHtml, postJson } from "../lib/http.ts"
import {
  cleanMultiline,
  computeTotal,
  dedupeContatos,
  fixUpperCase,
  preposicaoBairro,
  inferGarantias,
  inferMobiliado,
  inferPet,
  inline,
  makeContato,
  mapTipo,
  parseBRL,
  parseCoord,
  parseIntOrNull,
  parseNextData,
  slugify,
  uniq,
} from "../lib/text.ts"

// Ids de características - são globais na plataforma (conferido em 4 imobiliárias).
const CH = {
  areaConstruida: 1,
  areaTotal: 2,
  dormitorios: 5,
  suites: 6,
  banheiros: 7,
  garagens: 12,
  mobilia: 27,
  areaUtil: 95,
  totalBanheiros: 176,
  aceitaPet: 194,
  semiMobiliado: 467,
  naoAceitaPet: 621,
} as const

const FIELD_LIST = [
  "idtProperty", "jsonPhotos", "namStreet", "namDistrict", "namCity", "namState", "namCategory",
  "namSubCategory", "namCondominium", "valLocation", "valMonthIptu", "valIptuCalculated",
  "valCondominium", "valCondominiumCalculated", "latitude", "longitude", "flgShowMapSite",
  "totalRooms", "totalGarages", "idtsCharacteristics", "idtsCondominiumCharacteristics", "indType",
  "desTitleSite", "desInformationSite", "dtaUpdate", "dtaInsert", "flgPendingLocation",
  "flgReservedLocation", "flgHideValLocationSite", "flgRentByPeriod",
  ...Object.values(CH).map((id) => `prop_char_${id}`),
]

const PAGE_SIZE = 50

interface SiteInfo {
  base: string
  imob: string | null
  idtCity: number | null
  cidadeNome: string | null
  contatos: Contato[]
  caracteristicas: Map<number, string>
  opcoes: Record<string, unknown>
}

const siteCache = new Map<string, SiteInfo>()

function baseUrl(fonte: Fonte): string {
  return fonte.url.replace(/\/+$/, "")
}

/** Contatos da imobiliária a partir de template.imobInfo (formatos variam por site). */
export function parseImobInfo(info: any, nomeImobiliaria: string, ddd?: string): Contato[] {
  if (!info || typeof info !== "object") return []
  const out: Contato[] = []
  const email = typeof info.email === "string" ? info.email : null
  const whats: string[] = []
  if (typeof info.whatsapp === "string") whats.push(info.whatsapp)
  else if (Array.isArray(info.whatsapp)) {
    for (const w of info.whatsapp) if (w && typeof w.number === "string") whats.push(w.number)
  }
  for (const w of whats) {
    out.push(makeContato({ nome: nomeImobiliaria, papel: "imobiliaria", email }, w, { whatsapp: w, dddPadrao: ddd }))
  }
  // "phone" às vezes vem com dois números: "(14) 3354-7985 | (14) 99644-7985"
  const phones = [info.phone, info.phone2]
    .filter((p) => typeof p === "string" && p.trim())
    .flatMap((p: string) => p.split(/[|/;]| e /))
  for (const p of phones) out.push(makeContato({ nome: nomeImobiliaria, papel: "imobiliaria", email }, p, { dddPadrao: ddd }))
  if (!out.length && email) out.push({ nome: nomeImobiliaria, papel: "imobiliaria", telefone: null, whatsapp: null, email, creci: null })
  return dedupeContatos(out)
}

async function siteInfo(fonte: Fonte, opts: SearchOptions): Promise<SiteInfo> {
  const base = baseUrl(fonte)
  const citySlug = `${slugify(opts.cidade)}-${opts.uf.toLowerCase()}`
  const key = `${base}|${citySlug}`
  const cached = siteCache.get(key)
  if (cached) return cached

  const html = await getHtml(`${base}/alugar/${citySlug}`, { signal: opts.signal })
  if (!html) throw new Error(`página /alugar/${citySlug} não existe neste site (a imobiliária atende ${opts.cidade}?)`)
  const t = parseNextData(html)?.props?.initialProps?.pageProps?.template
  if (!t) throw new Error("__NEXT_DATA__.template ausente - o msys mudou a marcação? (docs/portais.md#msys)")

  const places: any[] = Array.isArray(t.data?.initialPlaces) ? t.data.initialPlaces : []
  const place = places.find((p) => slugify(p?.city?.namCity ?? "") === slugify(opts.cidade)) ?? null
  const idtCity =
    place?.city?.idtCity ?? (places.length === 0 ? null : (t.data?.initialData?.idtCityList?.[0] ?? null))

  const caracteristicas = new Map<number, string>()
  for (const c of t.requests?.allCharacteristics ?? []) {
    if (c && typeof c.idtCharacteristics === "number" && typeof c.desCharacteristics === "string") {
      caracteristicas.set(c.idtCharacteristics, c.desCharacteristics.trim())
    }
  }

  const info: SiteInfo = {
    base,
    imob: typeof t.imob === "string" ? t.imob : null,
    idtCity: typeof idtCity === "number" ? idtCity : null,
    cidadeNome: place?.city?.namCity ?? null,
    contatos: parseImobInfo(t.imobInfo, fonte.nome),
    caracteristicas,
    opcoes: (t.options as Record<string, unknown>) ?? {},
  }
  siteCache.set(key, info)
  return info
}

function hasChar(ids: string | null | undefined, id: number): boolean {
  return typeof ids === "string" && ids.includes(`|${id}|`)
}

function parsePhotos(json: unknown): string[] {
  if (typeof json !== "string" || !json.trim()) return []
  try {
    const arr = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    return uniq(arr.filter((p: any) => p && !p.flgNotShowSite).map((p: any) => p.urlPhoto))
  } catch {
    return []
  }
}

// Características que valem mostrar como etiqueta (as numéricas viram campos próprios).
const TAG_RE =
  /mob[ií]l|arm[áa]rio|ar condicionado|piscina|quintal|sacada|varanda|churrasq|ed[íi]cula|elevador|portaria|port[ãa]o|academia|playground|sal[ãa]o de festas|interfone|aquecedor|aquecimento|lareira|jardim|[áa]rea de servi[çc]o|lavanderia|despensa|escrit[óo]rio|closet|pet|seguran[çc]a|c[âa]mera|cerca|gourmet|vista|andar alto|t[ée]rrea|sobrado/i

const TAG_RENAME: Record<string, string> = {
  "Mobília": "Mobiliado",
  "Semi mobiliado": "Semimobiliado",
  "Lavanderias": "Lavanderia",
}

function tagName(name: string): string {
  return TAG_RENAME[name] ?? name
}

/** Semimobiliado substitui "Mobiliado" (o msys marca os dois no mesmo imóvel). */
function finishTags(tags: string[]): string[] {
  const out = uniq(tags)
  return out.includes("Semimobiliado") ? out.filter((t) => t !== "Mobiliado") : out
}

function tagsFrom(ids: string | null | undefined, dict: Map<number, string>): string[] {
  if (typeof ids !== "string") return []
  const out: string[] = []
  for (const m of ids.matchAll(/\|(\d+)\|/g)) {
    const name = dict.get(Number(m[1]))
    if (name && TAG_RE.test(name)) out.push(tagName(name))
  }
  return finishTags(out)
}

/** O msys grava 0 quando o valor não foi preenchido - tratamos como "não informado". */
function positiveOrNull(v: unknown): number | null {
  const n = parseBRL(v)
  return n != null && n > 0 ? n : null
}

function canonicalUrl(base: string, d: any): string {
  const tipoSeg = d.indType === "L" ? "locacao" : d.indType === "SL" ? "venda-e-locacao" : "locacao"
  const bairro = [d.namDistrict, d.namCondominium].filter(Boolean).map((s: string) => slugify(s)).join("-")
  const parts = [slugify(d.namCategory ?? "imovel"), slugify(d.namCity ?? ""), bairro || "bairro"]
  return `${base}/imovel/${tipoSeg}/${parts.join("/")}/${d.idtProperty}`
}

const UF_BY_NAME: Record<string, string> = { "sao paulo": "SP", "minas gerais": "MG", "parana": "PR", "rio de janeiro": "RJ" }

/** Converte um doc da API msys para o contrato. Exportado para os testes. */
export function docToImovel(d: any, fonte: Fonte, site: Pick<SiteInfo, "base" | "caracteristicas" | "contatos">): Imovel {
  const id = String(d.idtProperty)
  const hidePrice = d.flgHideValLocationSite === 1 || d.flgHideValLocationSite === true
  const aluguel = hidePrice ? null : positiveOrNull(d.valLocation)
  const condominio = positiveOrNull(d.valCondominiumCalculated ?? d.valCondominium)
  const iptu = positiveOrNull(d.valIptuCalculated ?? d.valMonthIptu)
  const descricao = cleanMultiline(d.desInformationSite)
  // Sem título cadastrado: "Apartamento no Jardim Bom Pastor", "Casa sobrado na Vila Maria"...
  const categoria = String(d.namCategory ?? "Imóvel").replace(/s$/i, "")
  const sub = d.namSubCategory && !/^padr[ãa]o$/i.test(d.namSubCategory) ? ` ${String(d.namSubCategory).toLowerCase()}` : ""
  const bairroTitulo = fixUpperCase(d.namDistrict)
  const titulo =
    inline(d.desTitleSite) ??
    inline(`${categoria}${sub}${bairroTitulo ? ` ${preposicaoBairro(bairroTitulo)} ${bairroTitulo}` : ""}`) ??
    `Imóvel ${id}`
  const ids = d.idtsCharacteristics as string | undefined
  const tags = tagsFrom(ids, site.caracteristicas)
  if (d.flgReservedLocation === 1 || d.flgPendingLocation === 1) tags.unshift("Reservado / em negociação")

  const mobiliado =
    hasChar(ids, CH.mobilia) || hasChar(ids, CH.semiMobiliado) ? true : inferMobiliado(titulo, descricao)
  const aceita_pet = hasChar(ids, CH.naoAceitaPet) ? false : hasChar(ids, CH.aceitaPet) ? true : inferPet(descricao)
  const showMap = d.flgShowMapSite === 1 || d.flgShowMapSite === true

  return {
    ...emptyImovel({ id, fonte: fonte.id, plataforma: "msys", url: canonicalUrl(site.base, d), titulo }),
    anunciante: fonte.nome,
    tipo: mapTipo(d.namCategory, d.namSubCategory),
    subtipo: inline([d.namCategory, d.namSubCategory].filter(Boolean).join(" · ")),
    aluguel,
    condominio,
    iptu,
    total: computeTotal(aluguel, condominio, iptu),
    quartos: parseIntOrNull(d[`prop_char_${CH.dormitorios}`] ?? d.totalRooms),
    suites: parseIntOrNull(d[`prop_char_${CH.suites}`]),
    banheiros: parseIntOrNull(d[`prop_char_${CH.totalBanheiros}`] ?? d[`prop_char_${CH.banheiros}`]),
    vagas: parseIntOrNull(d.totalGarages ?? d[`prop_char_${CH.garagens}`]),
    area: parseBRL(d[`prop_char_${CH.areaUtil}`] ?? d[`prop_char_${CH.areaConstruida}`] ?? d[`prop_char_${CH.areaTotal}`]),
    bairro: fixUpperCase(d.namDistrict),
    endereco: fixUpperCase(d.namStreet),
    cidade: fixUpperCase(d.namCity),
    uf: UF_BY_NAME[String(d.namState ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()] ?? null,
    lat: showMap ? parseCoord(d.latitude) : null,
    lng: showMap ? parseCoord(d.longitude) : null,
    fotos: parsePhotos(d.jsonPhotos),
    descricao,
    caracteristicas: finishTags(tags),
    mobiliado,
    aceita_pet,
    garantias: inferGarantias(descricao),
    contatos: site.contatos,
    referencia: id,
    publicado_em: typeof d.dtaInsert === "string" ? d.dtaInsert : null,
    atualizado_em: typeof d.dtaUpdate === "string" ? d.dtaUpdate : null,
    detalhado: false,
  }
}

async function search(fonte: Fonte, opts: SearchOptions): Promise<SearchResult> {
  const site = await siteInfo(fonte, opts)
  if (site.idtCity == null) {
    return { imoveis: [], total: 0, completo: true, avisos: [`${fonte.nome}: sem imóveis em ${opts.cidade} neste site`] }
  }
  const maxPaginas = opts.maxPaginas ?? 20
  const imoveis: Imovel[] = []
  const seen = new Set<string>()
  let total: number | null = null

  for (let page = 0; page < maxPaginas; page++) {
    const body = {
      type: "L",
      idtCityList: [site.idtCity],
      toPrice: opts.aluguelMax ?? null,
      start: page * PAGE_SIZE,
      numRows: PAGE_SIZE,
      getAccess: true,
      post: true,
      sortList: ["dtaUpdate desc"],
      fieldList: FIELD_LIST,
      jsonPhotosNum: 40,
      hidePendingLocation: Boolean(site.opcoes.hidePendingLocation),
      hidePrevisionOutput: Boolean(site.opcoes.hidePrevisionOutput),
    }
    const res = await postJson<any>(`${site.base}/api/service/consult`, body, { signal: opts.signal })
    const docs: any[] = res?.response?.docs ?? []
    total = typeof res?.response?.numFound === "number" ? res.response.numFound : total
    for (const d of docs) {
      if (d?.idtProperty == null) continue
      const im = docToImovel(d, fonte, site)
      if (seen.has(im.id)) continue
      seen.add(im.id)
      imoveis.push(im)
    }
    opts.log?.(`${fonte.id}: página ${page + 1} - ${imoveis.length}/${total ?? "?"}`)
    if (docs.length < PAGE_SIZE || (total != null && imoveis.length >= total)) break
  }

  return { imoveis, total, completo: total == null || imoveis.length >= total, avisos: [] }
}

/** Lê o __NEXT_DATA__ da página do imóvel. Exportado para os testes. */
export function parseDetailPage(html: string, fonte: Fonte, ddd?: string): Partial<Imovel> | null {
  const t = parseNextData(html)?.props?.initialProps?.pageProps?.template
  const p = t?.data?.property
  if (!p) return null

  const dict = new Map<number, string>()
  for (const c of t.requests?.allCharacteristics ?? []) {
    if (c && typeof c.idtCharacteristics === "number") dict.set(c.idtCharacteristics, String(c.desCharacteristics ?? "").trim())
  }
  const base = String(t.fullUrl ?? fonte.url).replace(/^(https?:\/\/[^/]+).*$/, "$1")
  const site = { base, caracteristicas: dict, contatos: parseImobInfo(t.imobInfo, fonte.nome, ddd) }
  const im = docToImovel(p, fonte, site)

  // Características "Sim" do imóvel e do condomínio, com rótulos legíveis.
  const extra: string[] = []
  for (const field of ["jsonCharacteristics", "jsonCondominiumCharacteristics"]) {
    try {
      const arr = JSON.parse(p[field] ?? "[]")
      for (const c of Array.isArray(arr) ? arr : []) {
        const id = c?.characteristics?.idtCharacteristics
        const name = c?.characteristics?.desCharacteristics ?? dict.get(id)
        const val = String(c?.desInformationFormatted ?? c?.desInformation ?? "")
        if (name && TAG_RE.test(name) && !/^(0|0,00|n[ãa]o)$/i.test(val.trim())) extra.push(tagName(name))
      }
    } catch {
      /* campo ausente ou malformado: segue só com os ids */
    }
  }

  const captadores: any[] = Array.isArray(t.data?.captivators) ? t.data.captivators : []
  const corretores = captadores
    .sort((a, b) => Number(Boolean(b?.isCaptivatorLocation)) - Number(Boolean(a?.isCaptivatorLocation)))
    .map((c) =>
      makeContato(
        { nome: c?.namPerson, papel: "corretor", email: c?.desEmail ?? null, creci: c?.creci ?? null },
        c?.desPhone,
        { dddPadrao: ddd },
      ),
    )

  return {
    ...im,
    caracteristicas: finishTags([...im.caracteristicas, ...extra]),
    contatos: dedupeContatos([...corretores, ...site.contatos]),
    detalhado: true,
  }
}

async function detail(fonte: Fonte, ref: DetailRef, opts: { signal?: AbortSignal } = {}): Promise<Partial<Imovel>> {
  const html = await getHtml(ref.url, { signal: opts.signal })
  if (!html) throw new Error("anúncio não encontrado (pode ter sido alugado)")
  const parsed = parseDetailPage(html, fonte)
  if (!parsed) throw new Error("não consegui ler os dados do anúncio - o msys mudou a marcação? (docs/portais.md#msys)")
  return parsed
}

export const msys: Portal = {
  plataforma: "msys",
  descricao: "Sites de imobiliária feitos no msysimob (Next.js + API JSON de busca)",
  search,
  detail,
}
