// Utilitários de texto compartilhados pelos adaptadores: entidades HTML, limpeza,
// slugs, números/preços no formato brasileiro, telefones e inferências a partir do
// texto livre dos anúncios (tipo, mobiliado, pet, garantias).

import type { Contato, Tipo } from "./types.ts"

// Sites de imobiliária pequenos ainda servem ISO-8859-1 com entidades nomeadas
// (&atilde;, &ccedil;...). Cobre as que aparecem em português; o resto passa intacto.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë",
  iacute: "í", igrave: "ì", icirc: "î", iuml: "ï",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö",
  uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü",
  ccedil: "ç", ntilde: "ñ",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Auml: "Ä",
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Iacute: "Í", Icirc: "Î",
  Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Uacute: "Ú", Uuml: "Ü",
  Ccedil: "Ç", Ntilde: "Ñ",
  ordf: "ª", ordm: "º", deg: "°", sup2: "²", sup3: "³", middot: "·", bull: "•",
  ndash: "–", mdash: "—", hellip: "…", trade: "™", reg: "®", copy: "©",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  euro: "€", frac12: "½", times: "×",
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    }
    return g in NAMED_ENTITIES ? NAMED_ENTITIES[g] : m
  })
}

/** HTML -> texto legível com quebras de linha. null para entrada vazia. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const withBreaks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d|tr|ul|ol|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

/** Texto em uma linha só, sem espaços duplicados. */
export function inline(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = decodeEntities(String(s)).replace(/\s+/g, " ").trim()
  return t || null
}

/** Texto multilinha limpo (descrições que já vêm como texto puro, com \r\n). */
export function cleanMultiline(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = decodeEntities(String(s))
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return t || null
}

export function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "")
}

export function slugify(s: string): string {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

const LOWER_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "na", "no"])

/** "VILA NOVA BOTUCATU" -> "Vila Nova Botucatu" (só mexe em textos todos em maiúsculas). */
export function fixUpperCase(s: string | null | undefined): string | null {
  const t = inline(s)
  if (!t) return null
  if (t !== t.toUpperCase() || !/[A-ZÀ-Ý]{3}/.test(t)) return t
  return t
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i > 0 && LOWER_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
}

/** "na Vila Maria", "no Jardim Paraíso", "na Chácara Floresta", "no Centro". */
export function preposicaoBairro(bairro: string): "na" | "no" {
  const w = stripAccents(bairro.trim().split(/\s+/)[0] ?? "").toLowerCase()
  return /^(vila|vl|chacara|cidade|fazenda|estancia|colonia|quinta|rua|avenida|praca|area|zona|comunidade|granja)$/.test(w) ? "na" : "no"
}

/** Nome em "Title-Case" hifenizado, sem acentos: "São Manuel" -> "Sao-Manuel". */
export function titleSlug(s: string): string {
  return stripAccents(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("-")
}

const BAIRRO_ABREV: Array<[RegExp, string]> = [
  [/\bjd\.?\s+/g, "jardim "],
  [/\bjdm\.?\s+/g, "jardim "],
  [/\bvl\.?\s+/g, "vila "],
  [/\bpq\.?\s+/g, "parque "],
  [/\bprq\.?\s+/g, "parque "],
  [/\bres\.?\s+/g, "residencial "],
  [/\bresid\.?\s+/g, "residencial "],
  [/\bconj\.?\s+/g, "conjunto "],
  [/\bcj\.?\s+/g, "conjunto "],
  [/\bch\.?\s+/g, "chacara "],
  [/\bsta\.?\s+/g, "santa "],
  [/\bsto\.?\s+/g, "santo "],
  [/\bns\.?\s+/g, "nossa senhora "],
  [/\bnsa\.?\s+/g, "nossa senhora "],
  [/\bdr\.?\s+/g, "doutor "],
]

/** Chave de comparação de bairros: sem acento, minúsculo, abreviações expandidas. */
export function normalizeBairro(s: string | null | undefined): string {
  if (!s) return ""
  let t = " " + stripAccents(String(s)).toLowerCase().replace(/[()]/g, " ") + " "
  for (const [re, rep] of BAIRRO_ABREV) t = t.replace(re, rep)
  return t.replace(/[^a-z0-9]+/g, " ").trim()
}

/** Chave de comparação de nomes de empresa (anunciantes em agregadores). */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return ""
  return stripAccents(String(s))
    .toLowerCase()
    .replace(/\b(ltda|me|eireli|s\/?a|imoveis|imobiliaria|negocios|imobiliarios|solucoes|corretora|de|da|do|dos|das|e)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/**
 * Converte valores em reais ou números no formato brasileiro.
 * "R$ 1.600,00" -> 1600 · "1.400,00" -> 1400 · "1902.38" -> 1902.38 · "40.00 m²" -> 40
 */
export function parseBRL(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const raw = String(v).replace(/R\$|\s| /g, "")
  if (!raw || /undefined|consult/i.test(raw)) return null
  const m = raw.match(/-?\d[\d.,]*/)
  if (!m) return null
  let s = m[0].replace(/[.,]$/, "")
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".") // 1.234,56
  else if (/\.\d{3}(\.|$)/.test(s) && !s.includes(",")) s = s.replace(/\./g, "") // 1.234 / 1.234.567
  else s = s.replace(/,/g, "") // 1234.56 / 1,234.56
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Inteiro positivo ou null (0 é mantido: "0 vagas" é informação). */
export function parseIntOrNull(v: unknown): number | null {
  if (v == null || v === "") return null
  if (Array.isArray(v)) return parseIntOrNull(v[0])
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""))
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null
}

export function parseCoord(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(String(v).trim())
  if (!Number.isFinite(n) || n === 0) return null
  return n
}

export interface Telefone {
  exibicao: string
  digitos: string
  e164: string
  celular: boolean
}

/**
 * Normaliza telefones brasileiros: "(014) 3815-8989", "+551438158989",
 * "5514996017071", "(14)99652-2205". Devolve null quando não parece telefone.
 */
export function parsePhone(raw: string | null | undefined, dddPadrao?: string): Telefone | null {
  if (!raw) return null
  let d = String(raw).replace(/\D/g, "")
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2)
  if (d.startsWith("0") && (d.length === 11 || d.length === 12)) d = d.slice(1)
  if ((d.length === 8 || d.length === 9) && dddPadrao) d = dddPadrao + d
  if (d.length !== 10 && d.length !== 11) return null
  const ddd = d.slice(0, 2)
  const num = d.slice(2)
  const celular = num.length === 9 && num[0] === "9"
  const exibicao =
    num.length === 9 ? `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}` : `(${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`
  return { exibicao, digitos: d, e164: "55" + d, celular }
}

/**
 * Monta um Contato a partir de telefone(s) soltos. `whatsappExplicito` vem de fontes que
 * dizem se o número tem WhatsApp; sem essa informação, só celulares ganham link.
 */
export function makeContato(
  base: Partial<Contato> & Pick<Contato, "papel">,
  telefone?: string | null,
  opts: { whatsapp?: string | null; whatsappExplicito?: boolean; dddPadrao?: string } = {},
): Contato {
  const tel = parsePhone(telefone ?? null, opts.dddPadrao)
  const wa = parsePhone(opts.whatsapp ?? null, opts.dddPadrao)
  let whatsapp: string | null = null
  if (wa) whatsapp = wa.e164
  else if (tel && (opts.whatsappExplicito ?? tel.celular)) whatsapp = tel.e164
  return {
    nome: inline(base.nome ?? null),
    papel: base.papel,
    telefone: tel?.exibicao ?? (wa ? wa.exibicao : null),
    whatsapp,
    email: base.email?.trim() || null,
    creci: base.creci?.toString().trim() || null,
  }
}

/**
 * Junta contatos repetidos (mesmo telefone, ou mesmo e-mail sem telefone), completando
 * WhatsApp/e-mail/CRECI de um com o outro. Preserva a ordem de primeira aparição.
 */
export function dedupeContatos(list: Contato[]): Contato[] {
  const out: Contato[] = []
  const byKey = new Map<string, Contato>()
  for (const c of list) {
    // Corretor sem telefone próprio ainda vale (nome + CRECI para pedir na imobiliária).
    if (!c.telefone && !c.whatsapp && !c.email && !(c.nome && c.creci)) continue
    const digits = (c.telefone ?? "").replace(/\D/g, "") || (c.whatsapp ?? "").replace(/^55/, "")
    const key = digits ? `t:${digits}` : c.email ? `e:${c.email.toLowerCase()}` : `n:${c.nome}|${c.creci}`
    const prev = byKey.get(key)
    if (prev) {
      prev.whatsapp ??= c.whatsapp
      prev.email ??= c.email
      prev.creci ??= c.creci
      prev.nome ??= c.nome
      continue
    }
    const copy = { ...c }
    byKey.set(key, copy)
    out.push(copy)
  }
  return out
}

/**
 * Classifica o tipo do imóvel a partir dos rótulos da plataforma
 * ("Apartamentos Kitnet", "Casa - Sobrado", "STUDIO_APARTMENT", slug da URL...).
 */
export function mapTipo(...parts: Array<string | null | undefined>): Tipo {
  const t = " " + stripAccents(parts.filter(Boolean).join(" ")).toLowerCase().replace(/[_-]+/g, " ") + " "
  if (/kit ?net|kitinete|quitinete|studio apartment/.test(t)) return "kitnet"
  if (/\bstudio\b|\bestudio\b|\bloft\b/.test(t)) return "studio"
  if (/\bflat\b/.test(t)) return "flat"
  if (/cobertura|penthouse/.test(t)) return "cobertura"
  if (/chacara|\bsitio\b|fazenda|rancho|\brural\b|small farm|\bfarm\b|haras/.test(t)) return "rural"
  if (/terreno|\blote\b|\bland\b/.test(t)) return "terreno"
  if (
    /galpao|barracao|deposito|armazem|\bshed\b|outhouse|comercial|\bponto\b|\bloja\b|\bsala\b|salao|escritorio|consultorio|\bpredio\b|\bbuilding\b|\bbusiness\b|\bpoint\b|\broom\b|\bhall\b|hotel|pousada|clinica|industrial|garagem|estacionamento|\bbox\b|\bparking\b/.test(
      t,
    )
  )
    return "comercial"
  if (/(casa|house|sobrado).*(condominio|condo)|condominio fechado|\bcondo house\b/.test(t)) return "casa_condominio"
  if (/sobrado|two story|assobradad/.test(t)) return "sobrado"
  if (/\bcasas?\b|\bhouse\b|edicula|residencia/.test(t)) return "casa"
  if (/apartamento|\baptos?\b|\bapartment\b|\bap\b|\bapto\b/.test(t)) return "apartamento"
  return "outro"
}

/**
 * Refina um tipo residencial pelo título do anúncio (muita imobiliária cadastra kitnet
 * como "Apartamento - Padrão"). Nunca transforma em comercial: título tem "sala" etc.
 */
export function refineTipo(tipo: Tipo, titulo: string | null | undefined): Tipo {
  const t = " " + stripAccents(String(titulo ?? "")).toLowerCase() + " "
  if (tipo === "apartamento" || tipo === "outro" || tipo === "flat") {
    if (/kit ?net|kitinete|quitinete/.test(t)) return "kitnet"
    if (/\bstudio\b|\bestudio\b|\bloft\b/.test(t)) return "studio"
    if (/\bcobertura\b/.test(t)) return "cobertura"
  }
  if (tipo === "casa" || tipo === "outro") {
    if (/condominio fechado|casa (em|de) condominio/.test(t)) return "casa_condominio"
    if (/\bsobrado\b/.test(t)) return "sobrado"
  }
  if (tipo === "outro") {
    if (/\bcasa\b/.test(t)) return "casa"
    if (/apartamento|\bapto\b/.test(t)) return "apartamento"
  }
  return tipo
}

function norm(text: string | null | undefined): string {
  return " " + stripAccents(String(text ?? "")).toLowerCase().replace(/\s+/g, " ") + " "
}

/** Mobiliado a partir do texto livre. null quando o texto não diz. */
export function inferMobiliado(...texts: Array<string | null | undefined>): boolean | null {
  const t = norm(texts.join(" \n "))
  if (/\b(nao|sem) (e |esta |sera )?(semi ?)?mobiliad/.test(t) || /\bvazio\b.*\bsem moveis\b/.test(t)) return false
  if (/mobiliad[oa]s?\b|\bfurnished\b|\bcom moveis\b/.test(t)) return true
  return null
}

/** Aceita animais, a partir do texto livre. null quando o texto não diz. */
export function inferPet(...texts: Array<string | null | undefined>): boolean | null {
  const t = norm(texts.join(" \n "))
  if (
    /(nao|proibid[oa]s?|vedad[oa]s?) (se )?(aceita(mos|m)?|permit\w*|sao permitidos)? ?(a )?(entrada de )?(animais|pets?|animal|cachorro)/.test(t) ||
    /(animais|pets?) (nao|proibid)/.test(t) ||
    /\bsem (animais|pets?)\b/.test(t)
  )
    return false
  if (
    /aceita(m|mos)? (animais|pets?|animal|cachorro)|pet ?friendly|permite(m)? (animais|pets?)|(animais|pets?) (sao )?(permitid|bem[ -]vind|aceit)/.test(
      t,
    )
  )
    return true
  return null
}

/** Garantias locatícias citadas no texto. */
export function inferGarantias(...texts: Array<string | null | undefined>): string[] {
  const t = norm(texts.join(" \n "))
  const g = new Set<string>()
  if (/sem fiador|nao (exige|precisa de) fiador/.test(t)) g.add("Sem fiador")
  else if (/\bfiador\b/.test(t)) g.add("Fiador")
  if (/seguro[ -]?fianca|fianca locaticia|seguro de fianca/.test(t)) g.add("Seguro-fiança")
  if (/caucao|deposito cau|(3|tres) (meses|alugueis) (de )?(deposito|adiantad)/.test(t)) g.add("Caução")
  if (/capitalizacao/.test(t)) g.add("Título de capitalização")
  if (/carta ?fianca/.test(t)) g.add("Carta fiança")
  if (/cartao de credito/.test(t)) g.add("Cartão de crédito")
  return [...g]
}

/** Soma aluguel + condomínio + IPTU com as partes conhecidas. */
export function computeTotal(aluguel: number | null, condominio: number | null, iptu: number | null): number | null {
  if (aluguel == null) return null
  return Math.round((aluguel + (condominio ?? 0) + (iptu ?? 0)) * 100) / 100
}

/** Primeiro elemento de um array ou o próprio valor (APIs que mandam [min, max]). */
export function first<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null
  if (Array.isArray(v)) return v.length ? (v[0] ?? null) : null
  return v
}

/** Remove duplicados e vazios preservando a ordem. */
export function uniq(list: Array<string | null | undefined>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of list) {
    const v = s?.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Extrai e interpreta o JSON de `<script id="__NEXT_DATA__">` (sites Next.js). */
export function parseNextData(html: string): any | null {
  const m = html.match(/<script[^>]+id=["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

/** Todos os blocos JSON-LD da página (arrays e @graph achatados). */
export function parseJsonLd(html: string): any[] {
  const out: any[] = []
  const re = /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    let j: any
    try {
      j = JSON.parse(m[1].trim())
    } catch {
      // Alguns sites põem quebras de linha cruas dentro de strings JSON-LD.
      try {
        j = JSON.parse(m[1].trim().replace(/[\r\n\t]+/g, " "))
      } catch {
        continue
      }
    }
    const items = Array.isArray(j) ? j : [j]
    for (const it of items) {
      if (it && Array.isArray(it["@graph"])) out.push(...it["@graph"])
      else if (it) out.push(it)
    }
  }
  return out
}
