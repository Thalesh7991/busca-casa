// Carrega e valida config/busca.json (critérios da busca + fontes). Caminhos do projeto.

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Fonte, Tipo } from "./types.ts"
import { TIPOS_RESIDENCIAIS } from "./types.ts"

export const ROOT = resolve(import.meta.dir, "..", "..")
export const CONFIG_PATH = process.env.BUSCA_IMOVEIS_CONFIG ?? join(ROOT, "config", "busca.json")
export const DATA_DIR = process.env.BUSCA_IMOVEIS_DATA ?? join(ROOT, "data")
export const WEB_DIR = join(ROOT, "web")

export interface LinkManual {
  nome: string
  url: string
  obs?: string
}

export interface Config {
  cidade: string
  uf: string
  ddd: string
  aluguel_max: number
  tipos: Tipo[]
  quartos_min: number
  buscar_detalhes: boolean
  max_paginas: number
  concorrencia: number
  atualizar_a_cada_horas: number
  porta: number
  mensagem_whatsapp: string
  fontes: Fonte[]
  busca_manual: LinkManual[]
}

const DEFAULTS: Omit<Config, "cidade" | "uf" | "fontes"> = {
  ddd: "",
  aluguel_max: 2000,
  tipos: TIPOS_RESIDENCIAIS,
  quartos_min: 0,
  buscar_detalhes: true,
  max_paginas: 20,
  concorrencia: 4,
  atualizar_a_cada_horas: 0,
  porta: 3000,
  mensagem_whatsapp:
    'Olá! Vi o anúncio "{titulo}"{ref} no {bairro} por R$ {aluguel}/mês ({url}). Ainda está disponível? Gostaria de agendar uma visita.',
  busca_manual: [],
}

export function loadConfig(path = CONFIG_PATH): Config {
  if (!existsSync(path)) throw new Error(`config não encontrada: ${path}`)
  let raw: any
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    throw new Error(`config/busca.json inválido: ${(e as Error).message}`)
  }
  const cfg: Config = { ...DEFAULTS, ...raw }
  if (!cfg.cidade || !cfg.uf) throw new Error("config: 'cidade' e 'uf' são obrigatórios")
  if (!Array.isArray(cfg.fontes)) throw new Error("config: 'fontes' deve ser uma lista")
  const ids = new Set<string>()
  for (const f of cfg.fontes) {
    if (!f.id || !f.plataforma || !f.url) throw new Error(`config: fonte incompleta: ${JSON.stringify(f)}`)
    if (!/^[a-z0-9_-]+$/.test(f.id)) throw new Error(`config: id de fonte inválido "${f.id}" (use a-z, 0-9, - e _)`)
    if (ids.has(f.id)) throw new Error(`config: id de fonte repetido "${f.id}"`)
    ids.add(f.id)
    f.nome ||= f.id
    f.ativo = f.ativo !== false
  }
  cfg.uf = cfg.uf.toUpperCase()
  cfg.aluguel_max = Number(cfg.aluguel_max) || DEFAULTS.aluguel_max
  cfg.concorrencia = Math.max(1, Math.min(8, Number(cfg.concorrencia) || 4))
  return cfg
}
