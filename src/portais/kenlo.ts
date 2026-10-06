// Adaptador Kenlo (antigo InGaia) - sites de imobiliária em Marko.js com o estado da
// página embutido em window.markoVars. Detalhes em docs/portais.md#kenlo.
//
// ⚠️ robots.txt dos sites Kenlo: `User-agent: * / Disallow: /` (só buscadores conhecidos
// são liberados). Por isso as fontes Kenlo vêm DESATIVADAS em config/busca.json. Ativar
// é decisão sua, para uso pessoal e em baixo volume - ver o aviso de cada fonte.
//
// Busca:   GET {site}/imoveis/para-alugar/{cidade}?preco-de-locacao=0~{max}&pagina={n}
//          -> markoVars['listings-*'].settings.listings = { count, data: [...] } (12/página)
// Detalhe: GET {site}{url} -> markoVars['listing-details-*'].settings.listing[0]
//          (corretor com celular/WhatsApp/CRECI, condomínio, descrição completa)

import type { Contato, DetailRef, Fonte, Imovel, Portal, SearchOptions, SearchResult } from "../lib/types.ts"
import { emptyImovel } from "../lib/types.ts"
import { getHtml } from "../lib/http.ts"
import {
  cleanMultiline,
  computeTotal,
  dedupeContatos,
  first,
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
  slugify,
  uniq,
} from "../lib/text.ts"

const POR_PAGINA = 12

const GARANTIAS: Record<string, string> = {
  GUARANTOR: "Fiador",
  BOND_INSURANCE: "Seguro-fiança",
  DEPOSIT: "Caução",
  SECURITY_DEPOSIT: "Caução",
  CAPITALIZATION: "Título de capitalização",
  CAPITALIZATION_BOND: "Título de capitalização",
  CREDIT_CARD: "Cartão de crédito",
  NO_GUARANTOR: "Sem fiador",
  WITHOUT_GUARANTOR: "Sem fiador",
}

const AMENIDADES: Record<string, string> = {
  FURNISHED: "Mobiliado",
  SEMI_FURNISHED: "Semimobiliado",
  PET_FRIENDLY: "Aceita pet",
  POOL: "Piscina",
  BARBECUE_GRILL: "Churrasqueira",
  GOURMET_BALCONY: "Varanda gourmet",
  BALCONY: "Sacada",
  AIR_CONDITIONING: "Ar condicionado",
  ELEVATOR: "Elevador",
  GYM: "Academia",
  PLAYGROUND: "Playground",
  PARTY_ROOM: "Salão de festas",
  ELECTRIC_GATE: "Portão eletrônico",
  CONCIERGE_24H: "Portaria 24h",
  SECURITY_24_HOURS: "Segurança 24h",
  BACKYARD: "Quintal",
  GARDEN: "Jardim",
  LAUNDRY_ROOM_BR: "Lavanderia",
  SERVICE_AREA: "Área de serviço",
  BUILTIN_WARDROBE: "Armários embutidos",
  KITCHEN_CABINETS: "Armários na cozinha",
  CLOSET: "Closet",
  INTERCOM: "Interfone",
}

function baseUrl(fonte: Fonte): string {
  return fonte.url.replace(/\/+$/, "")
}

/** Extrai o JSON de window.markoVars['<widget>-xxxx'] = {...}; */
export function parseMarkoVars(html: string, widget: string): any | null {
  const re = new RegExp(`window\\.markoVars\\['${widget}-[a-z0-9]+'\\] = (\\{[\\s\\S]*?\\});\\n\\s*\\}\\)\\(\\);`)
  const m = html.match(re)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/** Contatos da imobiliária a partir de offices/website do estado Kenlo. */
export function agencyContacts(state: any, nome: string): Contato[] {
  const out: Contato[] = []
  const chat = state?.website?.chat_whatsapp_phone
  if (typeof chat === "string" && chat.trim()) {
    out.push(makeContato({ nome, papel: "imobiliaria" }, chat, { whatsapp: chat, whatsappExplicito: true }))
  }
  for (const office of Array.isArray(state?.offices) ? state.offices : []) {
    for (const p of Array.isArray(office?.phones) ? office.phones : []) {
      if (p?.show === false || !p?.number) continue
      out.push(makeContato({ nome, papel: "imobiliaria" }, p.number, { whatsappExplicito: Boolean(p.whatsapp) }))
    }
  }
  return dedupeContatos(out)
}

/** Um anúncio do estado da listagem -> Imovel. Exportado para os testes. */
export function listingToImovel(d: any, fonte: Fonte, base: string, contatos: Contato[]): Imovel | null {
  const id = d?.property_full_reference
  if (!id) return null
  const aluguel = parseBRL(first(d.rent_price))
  const totalRent = parseBRL(d.total_rent)
  const amen: string[] = Array.isArray(d.amenities) ? d.amenities : []
  const descricao = cleanMultiline(d.listing_description)
  const bairro = inline(String(d.neighborhood_display ?? d.neighborhood ?? ""))
  const url = String(d.url ?? "").startsWith("http") ? d.url : `${base}${d.url ?? ""}`
  return {
    ...emptyImovel({
      id,
      fonte: fonte.id,
      plataforma: "kenlo",
      url,
      titulo: inline(d.website_title ?? d.heading1 ?? d.about_title) ?? `Imóvel ${id}`,
    }),
    anunciante: fonte.nome,
    tipo: mapTipo(d.property_type),
    subtipo: inline(d.type ?? null),
    aluguel,
    total: totalRent && aluguel && totalRent >= aluguel ? totalRent : aluguel,
    quartos: parseIntOrNull(first(d.bedrooms)),
    suites: parseIntOrNull(first(d.suites)),
    banheiros: parseIntOrNull(first(d.bathrooms)),
    vagas: parseIntOrNull(first(d.garages)),
    area: parseBRL(first(d.area)),
    bairro: fixUpperCase(bairro),
    cidade: inline(d.city),
    uf: inline(d.state),
    fotos: uniq((Array.isArray(d.photos) ? d.photos : []).map((p: any) => p?.picture_full ?? p?.picture_full_fallback)),
    descricao,
    caracteristicas: uniq(amen.map((a) => AMENIDADES[a]).filter(Boolean)),
    mobiliado: amen.includes("FURNISHED") || amen.includes("SEMI_FURNISHED") ? true : inferMobiliado(descricao),
    aceita_pet: amen.includes("PET_FRIENDLY") ? true : inferPet(descricao),
    garantias: uniq([
      ...(Array.isArray(d.rent_guarantee) ? d.rent_guarantee.map((g: string) => GARANTIAS[g] ?? null) : []),
      ...inferGarantias(descricao),
    ]),
    contatos,
    referencia: String(d.property_reference ?? id.replace(/-[A-Z0-9]+$/, "")),
    atualizado_em: typeof d.updated_at === "string" ? d.updated_at : null,
  }
}

async function search(fonte: Fonte, opts: SearchOptions): Promise<SearchResult> {
  const base = baseUrl(fonte)
  const cidade = slugify(opts.cidade)
  const maxPaginas = opts.maxPaginas ?? 20
  const byId = new Map<string, Imovel>()
  let total: number | null = null
  let esgotou = false
  let contatos: Contato[] = []

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const qs = new URLSearchParams()
    if (opts.aluguelMax) qs.set("preco-de-locacao", `0~${opts.aluguelMax}`)
    if (pagina > 1) qs.set("pagina", String(pagina))
    const url = `${base}/imoveis/para-alugar/${cidade}${qs.size ? "?" + qs.toString().replace(/%7E/g, "~") : ""}`
    const html = await getHtml(url, { signal: opts.signal })
    if (!html) {
      esgotou = true
      break
    }
    const state = parseMarkoVars(html, "listings")
    const listings = state?.settings?.listings
    if (!listings) throw new Error("estado markoVars da listagem ausente - o Kenlo mudou a marcação? (docs/portais.md#kenlo)")
    if (pagina === 1) {
      total = typeof listings.count === "number" ? listings.count : null
      contatos = agencyContacts(state, fonte.nome)
    }
    const data: any[] = Array.isArray(listings.data) ? listings.data : []
    for (const d of data) {
      const im = listingToImovel(d, fonte, base, contatos)
      if (im && !byId.has(im.id)) byId.set(im.id, im)
    }
    opts.log?.(`${fonte.id}: página ${pagina} - ${byId.size}/${total ?? "?"}`)
    if (data.length < POR_PAGINA || (total != null && byId.size >= total)) {
      esgotou = true
      break
    }
  }
  return { imoveis: [...byId.values()], total, completo: esgotou, avisos: [] }
}

/** Página de detalhe -> campos adicionais. Exportado para os testes. */
export function parseDetailPage(html: string, fonte: Fonte): Partial<Imovel> | null {
  const state = parseMarkoVars(html, "listing-details")
  const l = state?.settings?.listing?.[0]
  if (!l) return null
  const base = String(state?.server?.full_url ?? fonte.url).replace(/^(https?:\/\/[^/]+).*$/, "$1")
  const agency = agencyContacts(state, fonte.nome)
  const im = listingToImovel(l, fonte, base, agency)
  if (!im) return null
  const corretores: Contato[] = (Array.isArray(l.brokers) ? l.brokers : []).flatMap((b: any) => {
    const c: Contato[] = []
    const info = { nome: b?.broker_name, papel: "corretor" as const, email: b?.broker_email ?? null, creci: b?.broker_credential ?? null }
    if (b?.broker_mobile_phone) c.push(makeContato(info, b.broker_mobile_phone, { whatsappExplicito: b?.broker_whatsapp !== false }))
    if (b?.broker_phone) c.push(makeContato(info, b.broker_phone))
    if (!c.length) c.push(makeContato(info, null))
    return c
  })
  const condominio = parseBRL(l.condo_fees)
  const iptu = parseBRL(l.property_tax)
  const lat = parseCoord(l.lat ?? l.latitude ?? l.location?.lat)
  const lng = parseCoord(l.lng ?? l.lon ?? l.longitude ?? l.location?.lon ?? l.location?.lng)
  return {
    ...im,
    condominio: condominio && condominio > 0 ? condominio : null,
    iptu: iptu && iptu > 0 ? iptu : null,
    total: computeTotal(im.aluguel, condominio && condominio > 0 ? condominio : null, iptu && iptu > 0 ? iptu : null),
    lat,
    lng,
    contatos: dedupeContatos([...corretores, ...agency]),
    detalhado: true,
  }
}

async function detail(fonte: Fonte, ref: DetailRef, opts: { signal?: AbortSignal } = {}): Promise<Partial<Imovel>> {
  const html = await getHtml(ref.url, { signal: opts.signal })
  if (!html) throw new Error("anúncio não encontrado (pode ter sido alugado)")
  const parsed = parseDetailPage(html, fonte)
  if (!parsed) throw new Error("não consegui ler o anúncio - o Kenlo mudou a marcação? (docs/portais.md#kenlo)")
  return parsed
}

export const kenlo: Portal = {
  plataforma: "kenlo",
  descricao: "Sites de imobiliária na Kenlo (estado Marko embutido) - robots.txt restritivo, desativado por padrão",
  search,
  detail,
}
