// Utilitários dos testes: fixtures reais (gzip) e fontes de exemplo.
import { join } from "node:path"
import { decodeBody } from "../src/lib/http.ts"
import type { Fonte } from "../src/lib/types.ts"

export const FIXTURES = join(import.meta.dir, "fixtures")

/** Lê tests/fixtures/<nome>.gz e decodifica como o cliente HTTP faria. */
export async function fixtureHtml(nome: string, contentType = "text/html; charset=utf-8"): Promise<string> {
  const gz = new Uint8Array(await Bun.file(join(FIXTURES, nome)).arrayBuffer())
  return decodeBody(Bun.gunzipSync(gz), contentType)
}

export async function fixtureJson<T = any>(nome: string): Promise<T> {
  return JSON.parse(await Bun.file(join(FIXTURES, nome)).text()) as T
}

export function fonte(id: string, plataforma: string, url: string, nome = id): Fonte {
  return { id, nome, plataforma, url, ativo: true }
}
