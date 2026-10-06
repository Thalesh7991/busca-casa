// Lógica do estado (mesclagem entre execuções), deduplicação e critérios da busca.
// Tudo com funções puras - nenhum teste toca data/imoveis.json.

import { describe, expect, test } from "bun:test"
import { emptyImovel, type Imovel } from "../src/lib/types.ts"
import type { Config } from "../src/lib/config.ts"
import { applyResults, emptyState, mergeImovel, setStatus } from "../src/store.ts"
import { assignGroups, mesmoImovel, resolveFonte } from "../src/dedupe.ts"
import { atendeCriterios } from "../src/scrape.ts"
import { fonte } from "./helpers.ts"

function im(p: Partial<Imovel> & { id: string; fonte: string }): Imovel {
  return {
    ...emptyImovel({ id: p.id, fonte: p.fonte, plataforma: p.plataforma ?? "msys", url: `https://x.test/${p.fonte}/${p.id}`, titulo: p.titulo ?? `Imóvel ${p.id}` }),
    tipo: "apartamento",
    aluguel: 1500,
    total: 1500,
    quartos: 2,
    bairro: "Jardim Paraíso",
    cidade: "Botucatu",
    ...p,
  }
}

const T1 = "2026-09-01T10:00:00.000Z"
const T2 = "2026-09-02T10:00:00.000Z"

describe("applyResults", () => {
  test("novo anúncio entra com status novo e histórico de preço", () => {
    const s = emptyState()
    const r = applyResults(s, "sai", [im({ id: "1", fonte: "sai" })], true, T1)
    expect(r.novos).toEqual(["sai:1"])
    const reg = s.imoveis["sai:1"]
    expect(reg).toMatchObject({ status: "novo", ativo: true, primeira_vez: T1, ultima_vez: T1 })
    expect(reg.historico_precos).toEqual([{ data: "2026-09-01", aluguel: 1500, total: 1500 }])
  })

  test("segunda execução atualiza sem duplicar e registra mudança de preço", () => {
    const s = emptyState()
    applyResults(s, "sai", [im({ id: "1", fonte: "sai" })], true, T1)
    setStatus(s, "sai:1", "interesse")
    const r = applyResults(s, "sai", [im({ id: "1", fonte: "sai", aluguel: 1400, total: 1400 })], true, T2)
    expect(r.novos).toEqual([])
    expect(r.atualizados).toBe(1)
    const reg = s.imoveis["sai:1"]
    expect(reg.status).toBe("interesse") // status do usuário sobrevive à nova varredura
    expect(reg.primeira_vez).toBe(T1)
    expect(reg.historico_precos.map((h) => h.aluguel)).toEqual([1500, 1400])
  })

  test("sumiu numa busca completa -> inativo; busca parcial não prova nada", () => {
    const s = emptyState()
    applyResults(s, "sai", [im({ id: "1", fonte: "sai" }), im({ id: "2", fonte: "sai" })], true, T1)
    applyResults(s, "sai", [im({ id: "1", fonte: "sai" })], false, T2)
    expect(s.imoveis["sai:2"].ativo).toBe(true)
    const r = applyResults(s, "sai", [im({ id: "1", fonte: "sai" })], true, T2)
    expect(r.removidos).toBe(1)
    expect(s.imoveis["sai:2"]).toMatchObject({ ativo: false, inativo_desde: T2 })
    // Voltou a aparecer: reativado.
    applyResults(s, "sai", [im({ id: "1", fonte: "sai" }), im({ id: "2", fonte: "sai" })], true, T2)
    expect(s.imoveis["sai:2"]).toMatchObject({ ativo: true, inativo_desde: null })
  })

  test("outra fonte não é afetada pela busca completa de uma fonte", () => {
    const s = emptyState()
    applyResults(s, "sai", [im({ id: "1", fonte: "sai" })], true, T1)
    applyResults(s, "robuste", [im({ id: "9", fonte: "robuste" })], true, T1)
    applyResults(s, "sai", [], true, T2)
    expect(s.imoveis["robuste:9"].ativo).toBe(true)
    expect(s.imoveis["sai:1"].ativo).toBe(false)
  })
})

describe("mergeImovel", () => {
  test("listagem sem detalhe não apaga o que o detalhe trouxe", () => {
    const s = emptyState()
    applyResults(s, "sai", [im({ id: "1", fonte: "sai", descricao: "texto completo", condominio: 320, contatos: [{ nome: "Ilana", papel: "corretor", telefone: null, whatsapp: null, email: null, creci: "1" }], detalhado: true, lat: -22.8, lng: -48.4, coord_aprox: true })], true, T1)
    const merged = mergeImovel(s.imoveis["sai:1"], im({ id: "1", fonte: "sai" }))
    expect(merged.descricao).toBe("texto completo")
    expect(merged.condominio).toBe(320)
    expect(merged.contatos).toHaveLength(1)
    expect(merged.detalhado).toBe(true)
    expect(merged).toMatchObject({ lat: -22.8, lng: -48.4, coord_aprox: true })
    expect(merged.total).toBe(1820)
  })

  test("contato genérico da listagem não apaga o corretor que veio do detalhe", () => {
    const s = emptyState()
    const corretor = { nome: "Ilana", papel: "corretor" as const, telefone: null, whatsapp: null, email: null, creci: "261465-F" }
    const agencia = { nome: "S.A Imóveis", papel: "imobiliaria" as const, telefone: "(14) 3815-8989", whatsapp: null, email: null, creci: null }
    applyResults(s, "sai", [im({ id: "1", fonte: "sai", contatos: [corretor, agencia], caracteristicas: ["Portaria 24h"], detalhado: true })], true, T1)
    const merged = mergeImovel(s.imoveis["sai:1"], im({ id: "1", fonte: "sai", contatos: [agencia], caracteristicas: ["Lavanderia"] }))
    expect(merged.contatos.map((c) => c.nome)).toEqual(["Ilana", "S.A Imóveis"])
    expect(merged.caracteristicas).toEqual(["Portaria 24h", "Lavanderia"])
  })
})

describe("deduplicação", () => {
  const fontes = [
    fonte("pontes", "msys", "https://pontes.test", "Pontes Imobiliária"),
    fonte("concreto", "ksi", "https://concreto.test", "Rede Concreto Imóveis"),
    fonte("chavesnamao", "chavesnamao", "https://cnm.test", "Chaves na Mão"),
  ]

  test("anunciante do agregador é resolvido para a fonte direta", () => {
    expect(resolveFonte("PONTES IMOBILIÁRIA", fontes)).toBe("pontes")
    expect(resolveFonte("Rede Concreto Imóveis", fontes)).toBe("concreto")
    expect(resolveFonte("Re/max Invest", fontes)).toBeNull()
  })

  test("agrupa por referência informada no agregador", () => {
    const s = emptyState()
    applyResults(s, "pontes", [im({ id: "770", fonte: "pontes", referencia: "770", area: null })], true, T1)
    applyResults(s, "chavesnamao", [im({ id: "18543962", fonte: "chavesnamao", plataforma: "chavesnamao", referencia: "770", anunciante: "Pontes Imobiliária", aluguel: 1450, area: null })], true, T1)
    expect(assignGroups(s, fontes)).toBe(1)
    expect(s.imoveis["pontes:770"].grupo).toBe("g:pontes:770") // fonte direta é a principal
    expect(s.imoveis["chavesnamao:18543962"].grupo).toBe("g:pontes:770")
  })

  test("atributos só agrupam com área conhecida e compatível", () => {
    const a = { ...im({ id: "1", fonte: "pontes", area: 45 }), chave: "pontes:1" } as any
    const b = { ...im({ id: "2", fonte: "concreto", area: 46 }), chave: "concreto:2" } as any
    expect(mesmoImovel(a, b)).toBe(true)
    expect(mesmoImovel(a, { ...b, area: null })).toBe(false)
    expect(mesmoImovel(a, { ...b, area: 60 })).toBe(false)
    expect(mesmoImovel(a, { ...b, quartos: 1 })).toBe(false)
    expect(mesmoImovel(a, { ...b, bairro: "Centro" })).toBe(false)
    expect(mesmoImovel(a, { ...b, fonte: "pontes" })).toBe(false)
  })

  test("um grupo nunca junta dois anúncios da mesma fonte (sem contágio transitivo)", () => {
    const s = emptyState()
    // Duas kitnets iguais do mesmo prédio na Concreto + uma "igual" na Pontes.
    applyResults(s, "concreto", [im({ id: "1", fonte: "concreto", tipo: "kitnet", area: 30, quartos: 1 }), im({ id: "2", fonte: "concreto", tipo: "kitnet", area: 30, quartos: 1 })], true, T1)
    applyResults(s, "pontes", [im({ id: "3", fonte: "pontes", tipo: "kitnet", area: 30, quartos: 1 })], true, T1)
    assignGroups(s, fontes)
    const grupos = Object.values(s.imoveis).map((r) => r.grupo).filter(Boolean)
    const tamanho = new Map<string, number>()
    for (const g of grupos) tamanho.set(g!, (tamanho.get(g!) ?? 0) + 1)
    expect([...tamanho.values()].every((n) => n <= 2)).toBe(true)
    expect(s.imoveis["concreto:1"].grupo === null || s.imoveis["concreto:1"].grupo !== s.imoveis["concreto:2"].grupo).toBe(true)
  })
})

describe("critérios da busca", () => {
  const cfg = { cidade: "Botucatu", uf: "SP", aluguel_max: 2000, tipos: ["apartamento", "casa", "kitnet", "studio", "sobrado", "casa_condominio", "cobertura", "flat"], quartos_min: 0 } as unknown as Config

  test("filtra preço, tipo, cidade e quartos", () => {
    expect(atendeCriterios(im({ id: "1", fonte: "x" }), cfg)).toBe(true)
    expect(atendeCriterios(im({ id: "1", fonte: "x", aluguel: 2100 }), cfg)).toBe(false)
    expect(atendeCriterios(im({ id: "1", fonte: "x", tipo: "comercial" }), cfg)).toBe(false)
    expect(atendeCriterios(im({ id: "1", fonte: "x", cidade: "Bauru" }), cfg)).toBe(false)
    expect(atendeCriterios(im({ id: "1", fonte: "x", aluguel: null }), cfg)).toBe(true) // "consulte" fica
    expect(atendeCriterios(im({ id: "1", fonte: "x", quartos: 1 }), { ...cfg, quartos_min: 2 })).toBe(false)
  })

  test("refina tipo pelo título antes de filtrar", () => {
    const k = im({ id: "1", fonte: "x", tipo: "apartamento", titulo: "KITNET próxima à UNESP" })
    expect(atendeCriterios(k, cfg)).toBe(true)
    expect(k.tipo).toBe("kitnet")
  })
})
