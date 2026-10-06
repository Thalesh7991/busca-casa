// Adaptador KSI (kurole/ksi) - sites de imobiliária renderizados no servidor, em
// ISO-8859-1, usados pela S.A Imóveis e pela Rede Concreto. Detalhes em docs/portais.md#ksi.
//
// Busca:   GET {site}/alugar/{Cidade}?vma={max}&pag={n}  -> cards HTML (filtro de preço no servidor)
// Detalhe: GET {url do card} -> JSON-LD Product (fotos, descrição) + blocos de texto com
//          condomínio, IPTU, total/mês, corretor responsável e coordenadas.

import type { Contato, DetailRef, Fonte, Imovel, Portal, SearchOptions, SearchResult } from "../lib/types.ts"
import { emptyImovel } from "../lib/types.ts"
import { getHtml } from "../lib/http.ts"
import {
  computeTotal,
  decodeEntities,
  dedupeContatos,
  fixUpperCase,
  htmlToText,
  inferGarantias,
  inferMobiliado,
  inferPet,
  inline,
  makeContato,
  mapTipo,
  parseBRL,
  parseIntOrNull,
  parseJsonLd,
  titleSlug,
  uniq,
} from "../lib/text.ts"

function baseUrl(fonte: Fonte): string {
  return fonte.url.replace(/\/+$/, "")
}

/** "120 imóveis em Botucatu, SP até R$ 2.000,00" -> 120 */
export function parseTotal(html: string): number | null {
  const title = decodeEntities(html.match(/<title[^>]*>([^<]*)/i)?.[1] ?? "")
  const m = title.match(/(\d[\d.]*)\s+im[oó]ve(?:is|l)\b/i)
  return m ? Number(m[1].replace(/\./g, "")) : null
}

/** Telefones de contato da imobiliária (links tel:), na ordem da página. */
export function parseAgencyPhones(html: string): string[] {
  return uniq([...html.matchAll(/href=["']tel:([+\d()\s-]{8,})["']/gi)].map((m) => m[1]))
}

function attrNumber(card: string, re: RegExp): number | null {
  const m = card.match(re)
  return m ? parseBRL(m[1]) : null
}

/** Um card da listagem -> Imovel (sem condomínio/IPTU/corretor; esses vêm do detalhe). */
export function parseCard(card: string, fonte: Fonte, base: string, contatos: Contato[]): Imovel | null {
  const href = card.match(/href="((?:\/)?alugar\/[^"]+?\/(\d+))"/)
  const idFromCode = card.match(/C(?:&oacute;|ó)d\.\s*<strong>\s*([\w-]+)\s*<\/strong>/i)?.[1]
  const id = idFromCode ?? href?.[2]
  if (!href || !id) return null
  const url = new URL(href[1], base + "/").toString()

  const titulo = inline(card.match(/<h2[^>]*title="([^"]*)"/)?.[1]) ?? `Imóvel ${id}`
  // O tipo confiável está na URL (alugar/{Cidade}/{Tipo}/{Subtipo}/{Bairro}/{id}); o <h2>
  // às vezes é um título livre ("CONDOMÍNIO PARQUE BELGRADO").
  const segs = href[1].replace(/^\//, "").split("/")
  const tipoTxt = segs[2]?.replace(/-+/g, " ") ?? titulo
  const subtipoTxt = segs[3]?.replace(/-+/g, " ")

  // "R$ 1.600,00 L" (locação) - cards de imóveis à venda e locação trazem os dois valores.
  const valores = card.match(/<div class="card-valores">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? ""
  const precos = [...valores.matchAll(/R\$\s*([\d.,]+)\s*([LV])?/g)]
  const precoL = precos.find((p) => p[2] === "L") ?? precos.find((p) => !p[2])
  const aluguel = precoL ? parseBRL(precoL[1]) : null

  const bairroCidade = inline(htmlToText(card.match(/card-bairro-cidade-texto">([\s\S]*?)<\/div>/)?.[1]))
  let bairro: string | null = null
  let cidade: string | null = null
  let uf: string | null = null
  if (bairroCidade) {
    const idx = bairroCidade.lastIndexOf(" - ")
    const cidUf = idx >= 0 ? bairroCidade.slice(idx + 3) : bairroCidade
    bairro = idx >= 0 ? bairroCidade.slice(0, idx) : null
    const cm = cidUf.match(/^(.*?)\/([A-Z]{2})$/)
    cidade = cm ? cm[1].trim() : cidUf.trim()
    uf = cm ? cm[2] : null
  }

  const descricao = htmlToText(card.match(/<div class="card-texto">\s*<p>([\s\S]*?)<\/p>/)?.[1])
  const fotos = uniq(
    [...card.matchAll(/data-flickity-lazyload-src="([^"]+)"/g)].map((m) => m[1].replace("/foto_thumb/", "/foto_/")),
  )

  const quartos = attrNumber(card, /title="(\d+)\s+Dormit/i)
  const suites = attrNumber(card, /title="(\d+)\s+Su(?:&iacute;|í|i)te/i)
  const banheiros = attrNumber(card, /title="(\d+)\s+Banh/i)
  const vagas = attrNumber(card, /title="(\d+)\s+(?:Vaga|Garag)/i)
  const area = attrNumber(card, /title="([\d.,]+)\s*M(?:&sup2;|²|2)"/i)

  return {
    ...emptyImovel({ id, fonte: fonte.id, plataforma: "ksi", url, titulo }),
    anunciante: fonte.nome,
    tipo: mapTipo(tipoTxt, subtipoTxt),
    subtipo: subtipoTxt ? fixUpperCase(subtipoTxt) : null,
    aluguel,
    total: aluguel,
    quartos: quartos != null ? Math.round(quartos) : null,
    suites: suites != null ? Math.round(suites) : null,
    banheiros: banheiros != null ? Math.round(banheiros) : null,
    vagas: vagas != null ? Math.round(vagas) : null,
    area,
    bairro: fixUpperCase(bairro),
    cidade: fixUpperCase(cidade),
    uf,
    fotos,
    descricao,
    mobiliado: inferMobiliado(subtipoTxt, descricao),
    aceita_pet: inferPet(descricao),
    garantias: inferGarantias(descricao),
    contatos,
    referencia: id,
  }
}

export function parseListPage(html: string, fonte: Fonte, base: string, contatos: Contato[]): Imovel[] {
  const out: Imovel[] = []
  for (const card of html.split('<div class="card card-imo"').slice(1)) {
    const im = parseCard(card, fonte, base, contatos)
    if (im) out.push(im)
  }
  return out
}

function agencyContacts(html: string, fonte: Fonte): Contato[] {
  return dedupeContatos(parseAgencyPhones(html).slice(0, 2).map((p) => makeContato({ nome: fonte.nome, papel: "imobiliaria" }, p)))
}

async function search(fonte: Fonte, opts: SearchOptions): Promise<SearchResult> {
  const base = baseUrl(fonte)
  const cidadeSeg = titleSlug(opts.cidade)
  const maxPaginas = opts.maxPaginas ?? 20
  const imoveis: Imovel[] = []
  const seen = new Set<string>()
  let total: number | null = null
  let contatos: Contato[] = []
  let esgotou = false // chegou numa página sem anúncios novos = enumerou tudo que o site mostra

  for (let pag = 1; pag <= maxPaginas; pag++) {
    const qs = new URLSearchParams()
    if (opts.aluguelMax) qs.set("vma", String(opts.aluguelMax))
    if (pag > 1) qs.set("pag", String(pag))
    const url = `${base}/alugar/${cidadeSeg}${qs.size ? "?" + qs.toString() : ""}`
    const html = await getHtml(url, { signal: opts.signal })
    if (!html) {
      esgotou = true
      break
    }
    if (pag === 1) {
      total = parseTotal(html)
      contatos = agencyContacts(html, fonte)
    }
    const page = parseListPage(html, fonte, base, contatos)
    let novos = 0
    for (const im of page) {
      if (seen.has(im.id)) continue
      seen.add(im.id)
      imoveis.push(im)
      novos++
    }
    opts.log?.(`${fonte.id}: página ${pag} - ${imoveis.length}/${total ?? "?"}`)
    if (!novos || (total != null && imoveis.length >= total)) {
      esgotou = true
      break
    }
  }

  // O título às vezes conta 1-4 anúncios a mais do que os cards exibidos (destaques
  // repetidos entre páginas); o que importa é ter percorrido todas as páginas.
  return { imoveis, total, completo: esgotou, avisos: [] }
}

/** HTML -> lista de "tokens" de texto (cada nó de texto vira uma linha). */
function htmlToLines(html: string): string[] {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "\n")
      .replace(/<[^>]+>/g, "\n"),
  )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
}

const NUM_RE = /^\d[\d.,]*$/

function eqLabel(line: string, label: RegExp): boolean {
  return label.test(line)
}

/** Primeiro valor numérico logo depois de um rótulo ("Condomínio" -> "320,00"). */
function valueAfter(lines: string[], label: RegExp): number | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (eqLabel(lines[i], label) && NUM_RE.test(lines[i + 1])) return parseBRL(lines[i + 1])
  }
  return null
}

/** Valor numérico logo antes de um rótulo ("2" "Dormitórios"). */
function valueBefore(lines: string[], label: RegExp): number | null {
  for (let i = 1; i < lines.length; i++) {
    if (eqLabel(lines[i], label)) {
      const n = parseBRL(lines[i - 1])
      if (n != null) return n
    }
  }
  return null
}

function sectionItems(lines: string[], start: RegExp, stop: RegExp): string[] {
  const i = lines.findIndex((l) => start.test(l))
  if (i < 0) return []
  const out: string[] = []
  for (let j = i + 1; j < lines.length && j < i + 60; j++) {
    if (stop.test(lines[j])) break
    out.push(lines[j])
  }
  return out
}

/** Página de detalhe KSI -> campos adicionais. Exportado para os testes. */
export function parseDetailPage(html: string, fonte: Fonte): Partial<Imovel> {
  const ld = parseJsonLd(html).find((x) => x?.["@type"] === "Product")
  const lines = htmlToLines(html)

  const aluguel = valueAfter(lines, /^Aluguel$/i) ?? parseBRL(ld?.offers?.price)
  const condominio = valueAfter(lines, /^Condom[ií]nio$/i)
  const iptu = valueAfter(lines, /^IPTU$/i)
  const totalMes = valueAfter(lines, /^Total\s*\/\s*M[eê]s$/i)

  const itensImovel = sectionItems(lines, /^Itens do Im[oó]vel$/i, /^Itens do |^Conhe[çc]a |^Localiza[çc][ãa]o|^DISPON|^Fale com/i)
  const itensPredio = sectionItems(lines, /^Itens do Edif[ií]cio/i, /^Conhe[çc]a |^Localiza[çc][ãa]o|^DISPON|^Fale com/i)
    .filter((l) => !/^(Seguran[çc]a|Utilit[áa]rios|Lazer|Servi[çc]os)$/i.test(l))
    .slice(1) // o primeiro item é o nome do edifício

  const corretorIdx = lines.findIndex((l) => /^CORRETOR RESPONS[ÁA]VEL$/i.test(l))
  const contatos: Contato[] = []
  const phones = parseAgencyPhones(html)
  if (corretorIdx >= 0) {
    const nome = lines[corretorIdx + 1]?.replace(/\s+-\s+(Loca[çc][ãa]o|Venda|Vendas)$/i, "") ?? null
    const creci = lines[corretorIdx + 2]?.match(/CRECI\s*([\w-]+)/i)?.[1] ?? null
    if (nome) contatos.push({ nome, papel: "corretor", telefone: null, whatsapp: null, email: null, creci })
  }
  for (const p of phones.slice(0, 1)) contatos.push(makeContato({ nome: fonte.nome, papel: "imobiliaria" }, p))

  // Obs.: os {lat, lng} da página KSI são dos escritórios da imobiliária, não do imóvel -
  // por isso não viram coordenadas (um pino no escritório engana mais do que ajuda).
  const descricao = htmlToText(ld?.description ? String(ld.description).replace(/\n/g, "<br>") : null)
  const fotos = uniq(Array.isArray(ld?.image) ? ld.image : ld?.image ? [ld.image] : [])
  const status = lines.find((l) => /^(DISPON[IÍ]VEL|ALUGADO|RESERVADO|LOCADO|EM NEGOCIA[ÇC][ÃA]O)$/i.test(l)) ?? null

  const caracteristicas = uniq([
    ...(status && !/^DISPON/i.test(status) ? [status.charAt(0) + status.slice(1).toLowerCase()] : []),
    ...itensImovel,
    ...itensPredio,
  ]).filter((l) => l.length <= 60)

  const out: Partial<Imovel> = {
    aluguel,
    condominio: condominio && condominio > 0 ? condominio : null,
    iptu: iptu && iptu > 0 ? iptu : null,
    quartos: parseIntOrNull(valueBefore(lines, /^Dormit[óo]rios?$/i)),
    suites: parseIntOrNull(valueBefore(lines, /^Su[íi]tes?$/i)),
    banheiros: parseIntOrNull(valueBefore(lines, /^Banheiros?$/i)),
    vagas: parseIntOrNull(valueBefore(lines, /^(Garagens?|Vagas?)$/i)),
    area: valueBefore(lines, /^A\.\s*[ÚU]til$/i) ?? valueBefore(lines, /^A\.\s*Total$/i),
    caracteristicas,
    contatos: dedupeContatos(contatos),
    detalhado: true,
  }
  out.total = totalMes ?? computeTotal(aluguel, out.condominio ?? null, out.iptu ?? null)
  if (descricao) {
    out.descricao = descricao
    out.mobiliado = inferMobiliado(descricao, itensImovel.join(" "))
    out.aceita_pet = inferPet(descricao)
    out.garantias = inferGarantias(descricao)
  }
  if (fotos.length) out.fotos = fotos
  // Remove campos nulos para não apagar o que a listagem já trouxe.
  for (const k of Object.keys(out) as Array<keyof Imovel>) if (out[k] == null) delete out[k]
  return out
}

async function detail(fonte: Fonte, ref: DetailRef, opts: { signal?: AbortSignal } = {}): Promise<Partial<Imovel>> {
  const html = await getHtml(ref.url, { signal: opts.signal })
  if (!html) throw new Error("anúncio não encontrado (pode ter sido alugado)")
  return parseDetailPage(html, fonte)
}

export const ksi: Portal = {
  plataforma: "ksi",
  descricao: "Sites de imobiliária na plataforma KSI (HTML ISO-8859-1, filtro de preço vma=)",
  search,
  detail,
}
