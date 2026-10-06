// Contrato comum a todos os portais. Cada adaptador em src/portais/ converte o formato
// da sua plataforma para `Imovel`; o restante do sistema (agregador, estado, web) só
// conhece este formato. Campos ausentes são sempre `null` (ou lista vazia), nunca omitidos.

export type Tipo =
  | "apartamento"
  | "casa"
  | "casa_condominio"
  | "sobrado"
  | "kitnet"
  | "studio"
  | "cobertura"
  | "flat"
  | "comercial"
  | "terreno"
  | "rural"
  | "outro"

export const TIPOS_RESIDENCIAIS: Tipo[] = [
  "apartamento",
  "casa",
  "casa_condominio",
  "sobrado",
  "kitnet",
  "studio",
  "cobertura",
  "flat",
]

export const TIPOS_NAO_RESIDENCIAIS: Tipo[] = ["comercial", "terreno", "rural"]

export interface Contato {
  nome: string | null
  papel: "corretor" | "imobiliaria" | "anunciante"
  /** Formatado para exibição, ex. "(14) 99601-7071". */
  telefone: string | null
  /** Só dígitos com DDI, pronto para wa.me, ex. "5514996017071". */
  whatsapp: string | null
  email: string | null
  creci: string | null
}

export interface Imovel {
  /** Id do anúncio na fonte (único dentro da fonte). */
  id: string
  /** Id da fonte em config/busca.json (ex. "robuste"). */
  fonte: string
  plataforma: string
  /** Quem anuncia: a imobiliária ou, em agregadores, o anunciante informado. */
  anunciante: string | null
  url: string
  titulo: string
  tipo: Tipo
  subtipo: string | null
  /** Valores mensais em R$. */
  aluguel: number | null
  condominio: number | null
  iptu: number | null
  /** aluguel + condomínio + IPTU, quando a fonte informa (ou soma das partes conhecidas). */
  total: number | null
  quartos: number | null
  suites: number | null
  banheiros: number | null
  vagas: number | null
  /** m² (área útil quando disponível, senão total/construída). */
  area: number | null
  bairro: string | null
  endereco: string | null
  cidade: string | null
  uf: string | null
  lat: number | null
  lng: number | null
  /** true quando lat/lng são do centro do bairro, não do imóvel. */
  coord_aprox: boolean
  fotos: string[]
  descricao: string | null
  caracteristicas: string[]
  mobiliado: boolean | null
  aceita_pet: boolean | null
  /** Garantias locatícias aceitas (fiador, seguro-fiança, caução...). */
  garantias: string[]
  contatos: Contato[]
  /** Código do imóvel na imobiliária - usado para casar o mesmo imóvel entre fontes. */
  referencia: string | null
  publicado_em: string | null
  atualizado_em: string | null
  /** true quando a página de detalhe já foi lida (descrição completa, corretor etc.). */
  detalhado: boolean
}

export interface Fonte {
  id: string
  nome: string
  plataforma: string
  url: string
  ativo: boolean
  /** Outros nomes com que a imobiliária aparece em agregadores (para deduplicar). */
  apelidos?: string[]
  /** Aviso exibido ao usuário (ex.: robots.txt restritivo). */
  aviso?: string
}

export interface SearchOptions {
  cidade: string
  uf: string
  aluguelMax?: number
  tipos?: Tipo[]
  maxPaginas?: number
  signal?: AbortSignal
  log?: (msg: string) => void
}

export interface SearchResult {
  imoveis: Imovel[]
  /** Total informado pela fonte para a busca (quando disponível). */
  total: number | null
  /**
   * true quando todas as páginas foram lidas. Só nesse caso o agregador marca como
   * indisponíveis os anúncios que sumiram - uma busca parcial não prova nada.
   */
  completo: boolean
  avisos: string[]
}

export interface DetailRef {
  url: string
  id?: string
}

export interface Portal {
  plataforma: string
  descricao: string
  search(fonte: Fonte, opts: SearchOptions): Promise<SearchResult>
  /** Lê a página do anúncio e devolve os campos que ela acrescenta. */
  detail(fonte: Fonte, ref: DetailRef, opts?: { signal?: AbortSignal }): Promise<Partial<Imovel>>
}

/** Imovel com todos os campos opcionais preenchidos com o valor "vazio" do contrato. */
export function emptyImovel(base: Pick<Imovel, "id" | "fonte" | "plataforma" | "url" | "titulo">): Imovel {
  return {
    anunciante: null,
    tipo: "outro",
    subtipo: null,
    aluguel: null,
    condominio: null,
    iptu: null,
    total: null,
    quartos: null,
    suites: null,
    banheiros: null,
    vagas: null,
    area: null,
    bairro: null,
    endereco: null,
    cidade: null,
    uf: null,
    lat: null,
    lng: null,
    coord_aprox: false,
    fotos: [],
    descricao: null,
    caracteristicas: [],
    mobiliado: null,
    aceita_pet: null,
    garantias: [],
    contatos: [],
    referencia: null,
    publicado_em: null,
    atualizado_em: null,
    detalhado: false,
    ...base,
  }
}
