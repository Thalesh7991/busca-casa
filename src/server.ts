// Servidor web local (só escuta em 127.0.0.1): serve a interface em web/ e uma API JSON
// pequena sobre data/imoveis.json. Sem dependências - Bun.serve puro.
//
//   bun run app          # sobe em http://localhost:3000 e abre o navegador
//   bun run servidor     # idem, sem abrir o navegador

import { existsSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, WEB_DIR, type Config } from "./lib/config.ts"
import { getPortal } from "./portais/index.ts"
import { runScrape, type ProgressoFonte } from "./scrape.ts"
import { assignGroups } from "./dedupe.ts"
import { mergeImovel, readState, setStatus, updateState, type Execucao, type Status } from "./store.ts"
import { dadosInterface } from "./view.ts"

let config: Config = loadConfig()

const job: {
  rodando: boolean
  inicio: string | null
  progresso: Record<string, ProgressoFonte>
  ultimo: Execucao | null
  erro: string | null
} = { rodando: false, inicio: null, progresso: {}, ultimo: null, erro: null }

function iniciarBusca(fontes?: string[]): boolean {
  if (job.rodando) return false
  try {
    config = loadConfig() // pega edições feitas em config/busca.json sem reiniciar
  } catch (e) {
    job.erro = (e as Error).message
    return false
  }
  job.rodando = true
  job.inicio = new Date().toISOString()
  job.progresso = {}
  job.erro = null
  runScrape({ config, fontes, onProgress: (p) => (job.progresso = p) })
    .then(({ execucao }) => (job.ultimo = execucao))
    .catch((e) => (job.erro = (e as Error).message))
    .finally(() => (job.rodando = false))
  return true
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })

const erro = (msg: string, status = 400) => json({ error: msg }, status)

const ESTATICOS: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/favicon.svg": "favicon.svg",
}

async function lerCorpo(req: Request): Promise<any> {
  const text = await req.text()
  if (text.length > 100_000) throw new Error("corpo grande demais")
  return text ? JSON.parse(text) : {}
}

async function rotear(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  if (req.method === "GET" && ESTATICOS[path]) {
    const file = Bun.file(join(WEB_DIR, ESTATICOS[path]))
    if (!(await file.exists())) return new Response("não encontrado", { status: 404 })
    return new Response(file, { headers: { "Cache-Control": "no-cache" } })
  }

  if (path === "/api/dados" && req.method === "GET") {
    return json({ ...dadosInterface(readState(), config), busca: job })
  }

  if (path === "/api/buscar") {
    if (req.method === "GET") return json(job)
    if (req.method === "POST") {
      let fontes: string[] | undefined
      try {
        const body = await lerCorpo(req)
        if (Array.isArray(body?.fontes)) fontes = body.fontes.filter((x: unknown) => typeof x === "string")
      } catch {
        return erro("JSON inválido")
      }
      if (!iniciarBusca(fontes)) return json({ ...job, error: job.erro ?? "já existe uma busca em andamento" }, 409)
      return json(job, 202)
    }
  }

  const m = path.match(/^\/api\/imoveis\/([^/]+)(\/detalhe)?$/)
  if (m) {
    const chave = decodeURIComponent(m[1])
    if (!/^[a-z0-9_-]+:[\w.-]+$/i.test(chave)) return erro("chave inválida")

    if (!m[2] && req.method === "PATCH") {
      let body: any
      try {
        body = await lerCorpo(req)
      } catch {
        return erro("JSON inválido")
      }
      try {
        const reg = await updateState((s) => {
          if (!s.imoveis[chave]) throw new Error(`anúncio não encontrado: ${chave}`)
          if (typeof body.status === "string") setStatus(s, chave, body.status as Status)
          if (typeof body.notas === "string") s.imoveis[chave].notas = body.notas.slice(0, 5000)
          return s.imoveis[chave]
        })
        return json(reg)
      } catch (e) {
        const msg = (e as Error).message
        return erro(msg, msg.startsWith("anúncio não encontrado") ? 404 : 400)
      }
    }

    if (m[2] && req.method === "POST") {
      const atual = readState().imoveis[chave]
      if (!atual) return erro("anúncio não encontrado", 404)
      const fonte = config.fontes.find((f) => f.id === atual.fonte)
      if (!fonte) return erro(`fonte ${atual.fonte} não está mais na config`, 404)
      try {
        const d = await getPortal(fonte.plataforma).detail(fonte, { url: atual.url, id: atual.id })
        const reg = await updateState((s) => {
          const prev = s.imoveis[chave]
          const merged = mergeImovel(prev, { ...prev, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v != null)), detalhado: true })
          s.imoveis[chave] = merged
          assignGroups(s, config.fontes)
          return merged
        })
        return json(reg)
      } catch (e) {
        return erro(`não consegui ler o anúncio: ${(e as Error).message}`, 502)
      }
    }
  }

  return erro("rota não encontrada", 404)
}

function abrirNavegador(url: string): void {
  const cmd =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" })
  } catch {
    /* sem navegador disponível: a URL já foi impressa */
  }
}

function subir(): ReturnType<typeof Bun.serve> {
  let ultimoErro: unknown
  for (let porta = config.porta; porta < config.porta + 10; porta++) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: porta,
        fetch: (req) => rotear(req).catch((e) => erro(`erro interno: ${(e as Error).message}`, 500)),
      })
    } catch (e) {
      ultimoErro = e // porta ocupada: tenta a próxima
    }
  }
  throw ultimoErro
}

if (import.meta.main) {
  if (!existsSync(join(WEB_DIR, "index.html"))) {
    console.error(`interface não encontrada em ${WEB_DIR}`)
    process.exit(1)
  }
  const server = subir()
  const url = `http://localhost:${server.port}`
  const s = readState()
  const ativos = Object.values(s.imoveis).filter((r) => r.ativo).length
  console.log(`Busca Imóveis rodando em ${url}`)
  console.log(`${ativos} anúncios ativos no estado · Ctrl+C para parar`)
  if (!ativos) console.log('Estado vazio - clique em "Buscar agora" na interface (ou rode: bun run scrape)')
  if (config.atualizar_a_cada_horas > 0) {
    const ms = config.atualizar_a_cada_horas * 3_600_000
    setInterval(() => iniciarBusca(), ms)
    console.log(`Busca automática a cada ${config.atualizar_a_cada_horas}h enquanto o servidor estiver aberto`)
  }
  if (process.argv.includes("--open")) abrirNavegador(url)
}
