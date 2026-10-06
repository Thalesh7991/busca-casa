// Registro das plataformas. Para suportar uma nova plataforma, crie src/portais/<nome>.ts
// implementando `Portal` (ver src/lib/types.ts) e registre aqui. Para só adicionar mais
// uma imobiliária numa plataforma já suportada, basta uma entrada em config/busca.json.

import type { Portal } from "../lib/types.ts"
import { chavesnamao } from "./chavesnamao.ts"
import { kenlo } from "./kenlo.ts"
import { ksi } from "./ksi.ts"
import { msys } from "./msys.ts"

export const PORTAIS: Record<string, Portal> = {
  msys,
  ksi,
  chavesnamao,
  kenlo,
}

export function getPortal(plataforma: string): Portal {
  const p = PORTAIS[plataforma]
  if (!p) throw new Error(`plataforma desconhecida: "${plataforma}" (suportadas: ${Object.keys(PORTAIS).join(", ")})`)
  return p
}
