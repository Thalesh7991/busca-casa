// Parsers de cada plataforma contra páginas reais salvas em tests/fixtures (offline).
// Se um site mudar a marcação, estes testes continuam passando (as fixtures são
// antigas) - quem acusa a quebra é `bun run portal saude`. Aqui garantimos que o
// parser faz o que deveria com o formato conhecido.

import { describe, expect, test } from "bun:test"
import { fixtureHtml, fixtureJson, fonte } from "./helpers.ts"
import { parseNextData } from "../src/lib/text.ts"
import * as msys from "../src/portais/msys.ts"
import * as ksi from "../src/portais/ksi.ts"
import * as cnm from "../src/portais/chavesnamao.ts"
import * as kenlo from "../src/portais/kenlo.ts"

describe("msys", () => {
  const f = fonte("robuste", "msys", "https://robuste.com.br", "Robuste Negócios Imobiliários")
  const site = { base: "https://robuste.com.br", caracteristicas: new Map([[27, "Mobília"], [194, "Aceita pet"]]), contatos: [] }

  test("docs da API /api/service/consult viram Imovel", async () => {
    const consult = await fixtureJson("msys-consult.json")
    const ims = consult.response.docs.map((d: any) => msys.docToImovel(d, f, site))
    expect(ims.length).toBeGreaterThan(0)
    for (const im of ims) {
      expect(im.fonte).toBe("robuste")
      expect(im.url).toMatch(/^https:\/\/robuste\.com\.br\/imovel\/(locacao|venda-e-locacao)\/.+\/\d+$/)
      expect(im.aluguel == null || im.aluguel <= 2000).toBe(true)
      expect(im.titulo.length).toBeGreaterThan(3)
      expect(im.titulo).not.toMatch(/&[a-z]+;/)
    }
    const terreno = ims.find((i: any) => i.id === "7147")
    expect(terreno?.tipo).toBe("terreno")
    expect(terreno?.titulo).toBe("Terreno na Vila Éden")
    expect(terreno?.iptu).toBeCloseTo(103.89)
  })

  test("contatos da imobiliária a partir do imobInfo", async () => {
    const t = parseNextData(await fixtureHtml("msys-lista.html.gz")).props.initialProps.pageProps.template
    const cs = msys.parseImobInfo(t.imobInfo, "Robuste")
    expect(cs[0]).toMatchObject({ telefone: "(14) 99601-7071", whatsapp: "5514996017071", email: "atendimento@robuste.com.br" })
    expect(cs.some((c) => c.telefone === "(14) 3112-7070" && c.whatsapp === null)).toBe(true)
  })

  test("detalhe traz corretor com CRECI, mobiliado e características do condomínio", async () => {
    const d = msys.parseDetailPage(await fixtureHtml("msys-detalhe.html.gz"), f)!
    expect(d.id).toBe("6895")
    expect(d.condominio).toBe(382)
    expect(d.mobiliado).toBe(true)
    expect(d.detalhado).toBe(true)
    expect(d.contatos?.[0]).toMatchObject({ nome: "Pedro Miguel Gonçalez Bezerra", papel: "corretor", creci: "294762", whatsapp: "5514996522205" })
    expect(d.caracteristicas).toContain("Portaria 24 Hrs")
  })
})

describe("ksi", () => {
  const f = fonte("sai", "ksi", "https://www.saimoveis.com.br", "S.A Imóveis")
  const latin1 = "text/html; charset=ISO-8859-1"

  test("listagem: total do título e cards", async () => {
    const html = await fixtureHtml("ksi-lista.html.gz", latin1)
    expect(ksi.parseTotal(html)).toBe(120)
    const cards = ksi.parseListPage(html, f, "https://www.saimoveis.com.br", [])
    expect(cards).toHaveLength(27)
    const c = cards[0]
    expect(c).toMatchObject({ id: "8071", tipo: "kitnet", aluguel: 1800, quartos: 2, suites: 1, banheiros: 1, area: 40, bairro: "Vila Pinheiro Machado", cidade: "Botucatu", uf: "SP" })
    expect(c.url).toBe("https://www.saimoveis.com.br/alugar/Botucatu/Apartamento/KITNET/Vila-Pinheiro-Machado/8071")
    expect(c.fotos[0]).toContain("/foto_/")
    for (const card of cards) {
      expect(card.aluguel).toBeLessThanOrEqual(2000)
      expect(card.titulo).not.toMatch(/&[a-z]+;/)
    }
  })

  test("telefone da imobiliária", async () => {
    expect(ksi.parseAgencyPhones(await fixtureHtml("ksi-lista.html.gz", latin1))).toEqual(["+551438158989"])
  })

  test("detalhe: condomínio, IPTU, total e corretor responsável", async () => {
    const d = ksi.parseDetailPage(await fixtureHtml("ksi-detalhe.html.gz", latin1), f)
    expect(d).toMatchObject({ aluguel: 1400, condominio: 320, iptu: 33.23, total: 1753.23, quartos: 2, banheiros: 1, area: 40 })
    expect(d.contatos?.[0]).toMatchObject({ nome: "Ilana", papel: "corretor", creci: "261465-F" })
    expect(d.contatos?.[1]).toMatchObject({ telefone: "(14) 3815-8989" })
    expect(d.descricao).toContain("JARDIM PARAÍSO")
    expect(d.lat).toBeUndefined() // coordenadas da página são do escritório - descartadas
  })
})

describe("chaves na mão", () => {
  const f = fonte("chavesnamao", "chavesnamao", "https://www.chavesnamao.com.br", "Chaves na Mão")

  test("listagem via JSON-LD, filtrando pela cidade", async () => {
    const { imoveis, total } = cnm.parseListPage(await fixtureHtml("cnm-lista.html.gz"), f, "sp-botucatu")
    expect(total).toBe(461)
    expect(imoveis).toHaveLength(15)
    expect(imoveis[0]).toMatchObject({ id: "39568460", tipo: "comercial", aluguel: 20000, bairro: "Vila São Judas Thadeu", cidade: "Botucatu", uf: "SP", anunciante: "Realize Negócios Imobiliários" })
    // Filtro de cidade: nenhum anúncio de outra cidade passa.
    expect(cnm.parseListPage(await fixtureHtml("cnm-lista.html.gz"), f, "sp-bauru").imoveis).toHaveLength(0)
  })

  test("detalhe: referência, condomínio, contatos e centro do bairro", async () => {
    const d = cnm.parseDetailPage(await fixtureHtml("cnm-detalhe.html.gz"), f)
    expect(d).toMatchObject({ referencia: "AL-JDP1247", aluguel: 3000, condominio: 480, total: 3480, quartos: 2, suites: 1, banheiros: 2, vagas: 2, mobiliado: true, anunciante: "Débora Martins", coord_aprox: true })
    expect(d.contatos?.[0]).toMatchObject({ telefone: "(14) 98837-0899", whatsapp: "5514988370899", creci: "110716-F" })
    expect(d.lat).toBeCloseTo(-22.8634, 3)
    expect(d.fotos?.length).toBe(14)
  })
})

describe("kenlo", () => {
  const f = fonte("expande", "kenlo", "https://www.expandecorretora.com.br", "Expande Corretora")

  test("estado markoVars da listagem", async () => {
    const state = kenlo.parseMarkoVars(await fixtureHtml("kenlo-lista.html.gz"), "listings")
    expect(state.settings.listings.count).toBe(147)
    const contatos = kenlo.agencyContacts(state, "Expande Corretora")
    expect(contatos[0]).toMatchObject({ telefone: "(14) 99731-1818", whatsapp: "5514997311818" })
    const im = kenlo.listingToImovel(state.settings.listings.data[0], f, "https://www.expandecorretora.com.br", contatos)!
    expect(im).toMatchObject({ id: "AP1507-EXPJ", referencia: "AP1507", tipo: "apartamento", aluguel: 1200, quartos: 2, area: 57, bairro: "Vila dos Lavradores" })
    expect(im.url).toBe("https://www.expandecorretora.com.br/imovel/apartamento-botucatu-2-quartos-57-m/AP1507-EXPJ")
  })

  test("detalhe: corretor, condomínio e garantias", async () => {
    const d = kenlo.parseDetailPage(await fixtureHtml("kenlo-detalhe.html.gz"), f)!
    expect(d).toMatchObject({ id: "AP1504-EXPJ", aluguel: 938, condominio: 412, total: 1350 })
    expect(d.garantias).toEqual(["Fiador", "Seguro-fiança"])
    expect(d.contatos?.[0]).toMatchObject({ nome: "Fabio Cruz", papel: "corretor", creci: "238392", whatsapp: "5514998781198" })
  })
})
