// Cliente HTTP dos adaptadores: User-Agent honesto (identifica a ferramenta, nunca finge
// ser um navegador), intervalo mínimo entre requisições ao mesmo host, timeout, e
// backoff exponencial com jitter em 429/5xx. Decodifica ISO-8859-1 quando o site declara.

export const USER_AGENT = "Mozilla/5.0 (compatible; busca-imoveis/1.0; uso pessoal)"

const MIN_GAP_MS = Number(process.env.BUSCA_IMOVEIS_GAP_MS ?? 350)
const nextSlot = new Map<string, number>()

/** Espaça requisições ao mesmo host (educação com sites pequenos de imobiliária). */
async function politeWait(url: string): Promise<void> {
  const host = new URL(url).host
  const now = Date.now()
  const slot = Math.max(now, nextSlot.get(host) ?? 0)
  nextSlot.set(host, slot + MIN_GAP_MS)
  if (slot > now) await Bun.sleep(slot - now)
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} em ${url}`)
  }
}

/** Página de bloqueio anti-robô (Cloudflare etc.) - nunca é "sem resultados". */
export class BlockedError extends HttpError {}

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

export async function httpFetch(url: string, o: FetchOptions = {}): Promise<Response> {
  const retries = o.retries ?? 4
  let delay = 600
  for (let attempt = 0; ; attempt++) {
    await politeWait(url)
    const timeout = AbortSignal.timeout(o.timeoutMs ?? 25_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: o.method ?? "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
          ...o.headers,
        },
        body: o.body,
        redirect: "follow",
        signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
      })
    } catch (e) {
      if (o.signal?.aborted) throw e
      if (attempt >= retries) throw new Error(`falha de rede em ${url}: ${(e as Error).message}`)
      await Bun.sleep(delay + Math.random() * 400)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await res.body?.cancel().catch(() => {})
      await Bun.sleep(delay + Math.random() * 400)
      delay = Math.min(delay * 2, 8000)
      continue
    }
    return res
  }
}

/** Decodifica o corpo respeitando o charset declarado (header ou <meta>). */
export function decodeBody(buf: Uint8Array, contentType: string | null): string {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase()
  if (!charset) {
    const head = new TextDecoder("windows-1252").decode(buf.subarray(0, 4096))
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase()
  }
  if (charset && /iso-8859-1|latin-?1|windows-1252|cp1252/.test(charset)) {
    return new TextDecoder("windows-1252").decode(buf)
  }
  return new TextDecoder("utf-8").decode(buf)
}

function looksBlocked(status: number, body: string): boolean {
  if (status !== 403 && status !== 503) return false
  return /Attention Required! \| Cloudflare|Just a moment\.\.\.|cf-chl-|captcha/i.test(body.slice(0, 20_000))
}

/** GET de HTML. null em 404/410 (anúncio ou página que deixou de existir). */
export async function getHtml(url: string, o: FetchOptions = {}): Promise<string | null> {
  const res = await httpFetch(url, {
    ...o,
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", ...o.headers },
  })
  if (res.status === 404 || res.status === 410) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const text = decodeBody(new Uint8Array(await res.arrayBuffer()), res.headers.get("content-type"))
  if (looksBlocked(res.status, text)) throw new BlockedError(res.status, url, `bloqueado pelo site (proteção anti-robô) em ${url}`)
  if (!res.ok) throw new HttpError(res.status, url)
  return text
}

export async function getJson<T>(url: string, o: FetchOptions = {}): Promise<T | null> {
  const res = await httpFetch(url, { ...o, headers: { Accept: "application/json", ...o.headers } })
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const text = await res.text()
  if (looksBlocked(res.status, text)) throw new BlockedError(res.status, url, `bloqueado pelo site (proteção anti-robô) em ${url}`)
  if (!res.ok) throw new HttpError(res.status, url)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`resposta não é JSON válido em ${url}`)
  }
}

export async function postJson<T>(url: string, body: unknown, o: FetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, {
    ...o,
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Accept: "application/json", ...o.headers },
  })
  const text = await res.text()
  if (looksBlocked(res.status, text)) throw new BlockedError(res.status, url, `bloqueado pelo site (proteção anti-robô) em ${url}`)
  if (!res.ok) throw new HttpError(res.status, url, `HTTP ${res.status} em ${url}: ${text.slice(0, 200)}`)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`resposta não é JSON válido em ${url}`)
  }
}

/** Executa tarefas com limite de concorrência, preservando a ordem dos resultados. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}
