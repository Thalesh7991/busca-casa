// Monta a versão estática da interface (para o GitHub Pages): copia web/ e grava o
// estado atual em dados.json, no mesmo formato do GET /api/dados do servidor local.
// Sem servidor não há como gravar nada - status e notas ficam no navegador de quem usa.
//
//   bun run exportar            # gera _site/
//   bun run exportar saida/     # outra pasta
//
// Usado pelo workflow .github/workflows/pagina.yml depois do `bun run scrape`.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { loadConfig, ROOT, WEB_DIR } from "./lib/config.ts"
import { readState } from "./store.ts"
import { dadosInterface } from "./view.ts"

const MARCA_SERVIDOR = '<meta name="busca-imoveis:modo" content="servidor">'
const MARCA_ESTATICO = '<meta name="busca-imoveis:modo" content="estatico">'

/** Página do workflow no GitHub, onde fica o botão "Run workflow" (só dentro do Actions). */
function urlAtualizar(): string | null {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_WORKFLOW_REF } = process.env
  const arquivo = GITHUB_WORKFLOW_REF?.match(/\.github\/workflows\/([^@]+)@/)?.[1]
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !arquivo) return null
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/workflows/${arquivo}`
}

export function exportar(destino: string): { imoveis: number; bytes: number } {
  const dados = dadosInterface(readState(), loadConfig())
  // Suas notas pessoais nunca vão para a página publicada.
  dados.imoveis = dados.imoveis.map((r) => ({ ...r, notas: "" }))
  const corpo = JSON.stringify({ ...dados, modo: "estatico", atualizar_url: urlAtualizar() })

  // A pasta de saída é recriada do zero - só se estiver vazia ou for um export anterior.
  if (existsSync(destino) && readdirSync(destino).length && !existsSync(join(destino, "dados.json")))
    throw new Error(`${destino} não está vazia e não parece um export anterior - escolha outra pasta`)
  rmSync(destino, { recursive: true, force: true })
  mkdirSync(destino, { recursive: true })
  cpSync(WEB_DIR, destino, { recursive: true })

  const index = readFileSync(join(WEB_DIR, "index.html"), "utf8")
  if (!index.includes(MARCA_SERVIDOR)) throw new Error(`web/index.html sem a marca ${MARCA_SERVIDOR}`)
  writeFileSync(join(destino, "index.html"), index.replace(MARCA_SERVIDOR, MARCA_ESTATICO))
  writeFileSync(join(destino, "dados.json"), corpo)
  return { imoveis: dados.imoveis.length, bytes: corpo.length }
}

if (import.meta.main) {
  const destino = resolve(process.argv[2] ?? join(ROOT, "_site"))
  try {
    const { imoveis, bytes } = exportar(destino)
    console.log(`site estático em ${destino}: ${imoveis} anúncios, dados.json com ${(bytes / 1024).toFixed(0)} KB`)
  } catch (e) {
    console.error(JSON.stringify({ error: (e as Error).message, code: "INTERNAL_ERROR" }))
    process.exit(1)
  }
}
