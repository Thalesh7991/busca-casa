import { describe, expect, test } from "bun:test"
import {
  decodeEntities,
  dedupeContatos,
  fixUpperCase,
  htmlToText,
  inferGarantias,
  inferMobiliado,
  inferPet,
  makeContato,
  mapTipo,
  normalizeBairro,
  normalizeName,
  parseBRL,
  parsePhone,
  preposicaoBairro,
  refineTipo,
  slugify,
  titleSlug,
} from "../src/lib/text.ts"

describe("parseBRL", () => {
  test.each([
    ["R$ 1.600,00", 1600],
    ["1.400,00", 1400],
    ["2118", 2118],
    [2118, 2118],
    ["1902.38", 1902.38],
    ["40.00 m²", 40],
    ["1.000m²", 1000],
    ["161.91 m²", 161.91],
    ["R$ 3.000", 3000],
    ["45,00 m²", 45],
    ["R$ 1.234.567,89", 1234567.89],
  ] as Array<[unknown, number]>)("%p -> %p", (entrada, esperado) => {
    expect(parseBRL(entrada)).toBe(esperado)
  })

  test.each([null, undefined, "", "--", "R$ -", "$undefined", "Sob consulta"])("%p -> null", (v) => {
    expect(parseBRL(v)).toBeNull()
  })
})

describe("parsePhone", () => {
  test("DDD com zero à esquerda e fixo", () => {
    expect(parsePhone("(014) 3815-8989")).toEqual({ exibicao: "(14) 3815-8989", digitos: "1438158989", e164: "551438158989", celular: false })
  })
  test("com DDI e celular", () => {
    const t = parsePhone("5514996017071")!
    expect(t.exibicao).toBe("(14) 99601-7071")
    expect(t.celular).toBe(true)
    expect(t.e164).toBe("5514996017071")
  })
  test("formatos colados e com +", () => {
    expect(parsePhone("(14)99652-2205")?.exibicao).toBe("(14) 99652-2205")
    expect(parsePhone("+551438158989")?.digitos).toBe("1438158989")
  })
  test("DDD 55 (RS) não é confundido com DDI", () => {
    expect(parsePhone("55999999999")?.digitos).toBe("55999999999")
  })
  test("sem DDD usa o padrão", () => {
    expect(parsePhone("99601-7071", "14")?.exibicao).toBe("(14) 99601-7071")
  })
  test("lixo vira null", () => {
    expect(parsePhone("123")).toBeNull()
    expect(parsePhone(null)).toBeNull()
  })
})

describe("makeContato / dedupeContatos", () => {
  test("celular ganha WhatsApp por padrão, fixo não", () => {
    expect(makeContato({ papel: "imobiliaria" }, "(14) 99601-7071").whatsapp).toBe("5514996017071")
    expect(makeContato({ papel: "imobiliaria" }, "(14) 3112-7070").whatsapp).toBeNull()
  })
  test("fonte que declara WhatsApp em fixo é respeitada", () => {
    expect(makeContato({ papel: "anunciante" }, "(14) 3354-7985", { whatsappExplicito: true }).whatsapp).toBe("551433547985")
  })
  test("mesmo telefone é fundido, completando o WhatsApp", () => {
    const a = makeContato({ nome: "X", papel: "anunciante" }, "(14) 3354-7985")
    const b = makeContato({ nome: "X", papel: "anunciante" }, "(14) 3354-7985", { whatsappExplicito: true })
    const out = dedupeContatos([a, b])
    expect(out).toHaveLength(1)
    expect(out[0].whatsapp).toBe("551433547985")
  })
  test("corretor sem telefone mas com CRECI é mantido", () => {
    const out = dedupeContatos([{ nome: "Ilana", papel: "corretor", telefone: null, whatsapp: null, email: null, creci: "261465-F" }])
    expect(out).toHaveLength(1)
  })
})

describe("mapTipo / refineTipo", () => {
  test.each([
    [["Apartamentos", "Kitnet"], "kitnet"],
    [["Apartamento", "KITNET"], "kitnet"],
    [["Apartamentos", "Padrão"], "apartamento"],
    [["STUDIO_APARTMENT"], "kitnet"],
    [["TWO_STORY_HOUSE"], "sobrado"],
    [["HOUSE"], "casa"],
    [["Casas", "Condomínio"], "casa_condominio"],
    [["Comercial", "Ponto Comercial"], "comercial"],
    [["casa comercial"], "comercial"],
    [["Rural", "Chacara"], "rural"],
    [["Terreno"], "terreno"],
    [["galpao"], "comercial"],
    [["Garagem", "Estacionamento"], "comercial"],
    [["Cobertura"], "cobertura"],
  ] as Array<[string[], string]>)("%p -> %p", (partes, esperado) => {
    expect(mapTipo(...partes)).toBe(esperado as any)
  })

  test("título refina tipo residencial", () => {
    expect(refineTipo("apartamento", "KITNET PARA ALUGAR PRÓXIMO À UNESP")).toBe("kitnet")
    expect(refineTipo("casa", "Sobrado 3 dormitórios")).toBe("sobrado")
    expect(refineTipo("outro", "Casa com quintal")).toBe("casa")
  })
  test("título nunca transforma em comercial", () => {
    expect(refineTipo("apartamento", "Apartamento com sala ampla perto de ponto de ônibus")).toBe("apartamento")
  })
})

describe("inferências do texto", () => {
  test("pet", () => {
    expect(inferPet("Aceita animais de pequeno porte")).toBe(true)
    expect(inferPet("Não aceita animais")).toBe(false)
    expect(inferPet("proibido animais")).toBe(false)
    expect(inferPet("Apartamento com 2 quartos")).toBeNull()
  })
  test("mobiliado", () => {
    expect(inferMobiliado("Apartamento mobiliado")).toBe(true)
    expect(inferMobiliado("Kitnet semi-mobiliada")).toBe(true)
    expect(inferMobiliado("imóvel não mobiliado")).toBe(false)
    expect(inferMobiliado("sala e cozinha")).toBeNull()
  })
  test("garantias", () => {
    expect(inferGarantias("Aceita fiador ou seguro fiança")).toEqual(["Fiador", "Seguro-fiança"])
    expect(inferGarantias("Locação sem fiador, com caução de 3 meses")).toEqual(["Sem fiador", "Caução"])
  })
})

describe("normalização", () => {
  test("bairros com abreviações e acentos", () => {
    expect(normalizeBairro("Jd. Paraíso")).toBe(normalizeBairro("Jardim Paraiso"))
    expect(normalizeBairro("Vila dos  Lavradores")).toBe("vila dos lavradores")
    expect(normalizeBairro("Jardim Botucatu (Rubião Júnior)")).toBe("jardim botucatu rubiao junior")
  })
  test("nomes de imobiliária", () => {
    expect(normalizeName("PONTES IMOBILIÁRIA")).toBe(normalizeName("Pontes Imobiliária"))
    expect(normalizeName("REDE CONCRETO IMÓVEIS")).toBe("rede concreto")
    expect(normalizeName("Dupla Negócios Imobiliários")).toBe("dupla")
  })
  test("slugs", () => {
    expect(slugify("São Manuel")).toBe("sao-manuel")
    expect(titleSlug("lençóis paulista")).toBe("Lencois-Paulista")
  })
  test("maiúsculas e preposição", () => {
    expect(fixUpperCase("VILA NOVA BOTUCATU")).toBe("Vila Nova Botucatu")
    expect(fixUpperCase("Jardim Paraíso")).toBe("Jardim Paraíso")
    expect(preposicaoBairro("Vila Maria")).toBe("na")
    expect(preposicaoBairro("Jardim Paraíso")).toBe("no")
  })
  test("entidades HTML e texto", () => {
    expect(decodeEntities("Para&iacute;so &amp; Cia &#8211; 40 m&sup2;")).toBe("Paraíso & Cia – 40 m²")
    expect(htmlToText("<p>Linha 1<br>Linha&nbsp;2</p><ul><li>item</li></ul>")).toBe("Linha 1\nLinha 2\n- item")
  })
})
