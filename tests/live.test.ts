// Testes ao vivo (acessam os sites de verdade, uma página cada). Opt-in:
//   PowerShell:  $env:LIVE=1; bun test tests/live.test.ts
//   Bash:        LIVE=1 bun test tests/live.test.ts
// Para diagnóstico do dia a dia prefira `bun run portal saude`.

import { describe, expect, test } from "bun:test"
import { loadConfig } from "../src/lib/config.ts"
import { getPortal } from "../src/portais/index.ts"

const LIVE = process.env.LIVE === "1"
const cfg = LIVE ? loadConfig() : null
const ativas = cfg?.fontes.filter((f) => f.ativo) ?? []

describe.skipIf(!LIVE)("fontes ao vivo", () => {
  for (const f of ativas) {
    test(
      `${f.id}: busca devolve anúncios com preço e URL`,
      async () => {
        const r = await getPortal(f.plataforma).search(f, { cidade: cfg!.cidade, uf: cfg!.uf, aluguelMax: cfg!.aluguel_max, tipos: cfg!.tipos, maxPaginas: 1 })
        expect(r.imoveis.length).toBeGreaterThan(0)
        const comPreco = r.imoveis.filter((i) => i.aluguel != null)
        expect(comPreco.length).toBeGreaterThan(r.imoveis.length / 2)
        for (const i of r.imoveis) expect(i.url).toMatch(/^https?:\/\//)
      },
      60_000,
    )
  }
})
