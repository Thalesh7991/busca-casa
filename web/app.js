// Interface da Busca Imóveis - JS puro, sem build. Lê /api/dados, filtra e ordena no
// navegador, e grava status/notas via PATCH /api/imoveis/:chave.
// Na página publicada (GitHub Pages, gerada por src/exportar.ts) não há servidor: lê
// dados.json e guarda status/notas no localStorage deste navegador.

const $ = (sel, el = document) => el.querySelector(sel)
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)]

const ESTATICO = $('meta[name="busca-imoveis:modo"]')?.content === "estatico"
const CHAVE_LOCAL = "busca-imoveis:acompanhamento"

const STATUS = {
  novo: { rotulo: "Novo", cor: "var(--st-novo)" },
  interesse: { rotulo: "Interesse", cor: "var(--st-interesse)" },
  contatado: { rotulo: "Contatado", cor: "var(--st-contatado)" },
  visita: { rotulo: "Visita", cor: "var(--st-visita)" },
  proposta: { rotulo: "Proposta", cor: "var(--st-proposta)" },
  descartado: { rotulo: "Descartado", cor: "var(--st-descartado)" },
}

const TIPO = {
  apartamento: "Apartamento",
  casa: "Casa",
  casa_condominio: "Casa em condomínio",
  sobrado: "Sobrado",
  kitnet: "Kitnet",
  studio: "Studio",
  cobertura: "Cobertura",
  flat: "Flat",
  comercial: "Comercial",
  terreno: "Terreno",
  rural: "Rural",
  outro: "Imóvel",
}

const GRUPO_TIPO = {
  apartamento: ["apartamento", "cobertura", "flat"],
  kitnet: ["kitnet", "studio"],
  casa: ["casa", "sobrado"],
  casa_condominio: ["casa_condominio"],
}

const FILTROS_PADRAO = {
  aba: "todos",
  texto: "",
  preco: null,
  base: "aluguel",
  quartos: 0,
  tipo: "",
  fonte: "",
  pet: false,
  mob: false,
  vaga: false,
  novos: false,
  inativos: false,
  ordem: "recentes",
  view: "lista",
}

const S = {
  config: null,
  regs: [],
  porChave: new Map(),
  grupos: new Map(),
  ultimaExec: null,
  filtros: { ...FILTROS_PADRAO },
  limite: 60,
  fotoIdx: new Map(),
  mapa: null,
  camadaMapa: null,
  polling: null,
  aberto: null,
  atualizarUrl: null,
}

// ---------------------------------------------------------------- utilidades

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

function brl(v, casas = 0) {
  if (v == null) return "—"
  return v.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: v % 1 ? 2 : casas })
}

function quando(iso) {
  if (!iso) return "—"
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 90) return "agora há pouco"
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`
  if (diff < 86400 * 30) return `há ${Math.round(diff / 86400)} dias`
  return d.toLocaleDateString("pt-BR")
}

function dataBR(iso) {
  return iso ? new Date(iso).toLocaleDateString("pt-BR") : "—"
}

function debounce(fn, ms) {
  let t
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

function lsGet(k, def) {
  try {
    const v = localStorage.getItem(k)
    return v ? JSON.parse(v) : def
  } catch {
    return def
  }
}

function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* navegação privada etc. */
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok && res.status !== 409) throw new Error(data.error || `HTTP ${res.status}`)
  return { status: res.status, data }
}

function toast(msg, acao) {
  const el = document.createElement("div")
  el.className = "toast"
  el.innerHTML = `<span>${esc(msg)}</span>`
  if (acao) {
    const b = document.createElement("button")
    b.textContent = acao.rotulo
    b.onclick = () => {
      acao.fn()
      el.remove()
    }
    el.append(b)
  }
  $("#toasts").append(el)
  setTimeout(() => el.remove(), acao ? 7000 : 4000)
}

// ---------------------------------------------------------------- dados

async function carregar() {
  const { data } = ESTATICO ? await api("dados.json", { cache: "no-cache" }) : await api("/api/dados")
  if (ESTATICO) {
    const locais = lsGet(CHAVE_LOCAL, {})
    for (const r of data.imoveis) Object.assign(r, locais[r.chave])
    S.atualizarUrl = data.atualizar_url ?? null
    $("#btn-buscar").classList.toggle("hidden", !S.atualizarUrl)
    $("#btn-buscar span").textContent = "Atualizar"
    $("#btn-buscar").title = 'Abre o GitHub Actions: clique em "Run workflow" e recarregue esta página em alguns minutos'
  }
  S.config = data.config
  S.regs = data.imoveis
  S.porChave = new Map(S.regs.map((r) => [r.chave, r]))
  S.grupos = new Map()
  for (const r of S.regs) {
    if (!r.grupo) continue
    if (!S.grupos.has(r.grupo)) S.grupos.set(r.grupo, [])
    S.grupos.get(r.grupo).push(r.chave)
  }
  S.ultimaExec = data.execucoes.at(-1) ?? null
  if (S.filtros.preco == null || S.filtros.preco > S.config.aluguel_max) S.filtros.preco = S.config.aluguel_max
  cabecalho()
  opcoesFontes()
  if (data.busca?.rodando) acompanharBusca()
  render()
}

function cabecalho() {
  const c = S.config
  const ativos = S.regs.filter((r) => r.ativo).length
  $("#subtitulo").textContent = `${c.cidade}/${c.uf} · aluguel até R$ ${brl(c.aluguel_max)} · ${ativos} anúncios ativos`
  const e = S.ultimaExec
  const falhas = Object.entries(e?.fontes || {}).filter(([, r]) => !r.ok).map(([id]) => nomeFonte(id))
  $("#ultima").textContent = e ? `última busca ${quando(e.fim || e.inicio)}${falhas.length ? ` · falhou: ${falhas.join(", ")}` : ""}` : "nenhuma busca ainda"
  const r = $("#f-preco")
  r.max = String(c.aluguel_max)
  r.min = String(Math.min(500, c.aluguel_max))
}

function opcoesFontes() {
  const sel = $("#f-fonte")
  const atual = S.filtros.fonte
  const usadas = new Set(S.regs.map((r) => r.fonte))
  sel.innerHTML =
    `<option value="">Todas as fontes</option>` +
    S.config.fontes
      .filter((f) => usadas.has(f.id))
      .map((f) => `<option value="${esc(f.id)}">${esc(f.nome)}</option>`)
      .join("")
  sel.value = atual
}

function nomeFonte(id) {
  return S.config?.fontes.find((f) => f.id === id)?.nome ?? id
}

// ---------------------------------------------------------------- filtros

function custo(r) {
  return S.filtros.base === "total" ? (r.total ?? r.aluguel) : r.aluguel
}

function daUltimaBusca(r) {
  return S.ultimaExec && r.primeira_vez === S.ultimaExec.inicio
}

function passaFiltros(r, ignorarAba = false) {
  const f = S.filtros
  if (!f.inativos && !r.ativo) return false
  if (!ignorarAba) {
    if (f.aba === "todos" && r.status === "descartado") return false
    if (f.aba !== "todos" && r.status !== f.aba) return false
  }
  const v = custo(r)
  if (v != null && f.preco != null && v > f.preco) return false
  if (f.quartos && (r.quartos == null || r.quartos < f.quartos)) return false
  if (f.tipo && !(GRUPO_TIPO[f.tipo] ?? [f.tipo]).includes(r.tipo)) return false
  if (f.fonte && r.fonte !== f.fonte) return false
  if (f.pet && r.aceita_pet !== true) return false
  if (f.mob && r.mobiliado !== true) return false
  if (f.vaga && !(r.vagas > 0)) return false
  if (f.novos && !daUltimaBusca(r)) return false
  if (f.texto) {
    const alvo = [r.titulo, r.bairro, r.endereco, r.anunciante, r.descricao, r.referencia, TIPO[r.tipo]].join(" ")
    const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    const t = norm(alvo)
    if (!norm(f.texto).split(/\s+/).filter(Boolean).every((p) => t.includes(p))) return false
  }
  return true
}

const ORDENS = {
  recentes: (a, b) => (b.primeira_vez || "").localeCompare(a.primeira_vez || "") || (b.atualizado_em || "").localeCompare(a.atualizado_em || ""),
  preco: (a, b) => (a.aluguel ?? 1e9) - (b.aluguel ?? 1e9),
  total: (a, b) => (a.total ?? a.aluguel ?? 1e9) - (b.total ?? b.aluguel ?? 1e9),
  m2: (a, b) => (a.area ? a.aluguel / a.area : 1e9) - (b.area ? b.aluguel / b.area : 1e9),
  area: (a, b) => (b.area ?? -1) - (a.area ?? -1),
  ia: (a, b) => (b.ia?.nota ?? -1) - (a.ia?.nota ?? -1),
}

/** Lista filtrada, ordenada e com um card por grupo de duplicados. */
function visiveis() {
  const lista = S.regs.filter((r) => passaFiltros(r)).sort(ORDENS[S.filtros.ordem] ?? ORDENS.recentes)
  const vistos = new Set()
  const out = []
  for (const r of lista) {
    if (r.grupo) {
      if (vistos.has(r.grupo)) continue
      vistos.add(r.grupo)
    }
    out.push(r)
  }
  return out
}

function outrosDoGrupo(r) {
  if (!r.grupo) return []
  return (S.grupos.get(r.grupo) ?? []).filter((k) => k !== r.chave).map((k) => S.porChave.get(k)).filter(Boolean)
}

// ---------------------------------------------------------------- render

function render() {
  lsSet("busca-imoveis:filtros", S.filtros)
  sincronizarControles()
  abas()
  const lista = visiveis()
  $("#contagem").textContent = lista.length
    ? `${lista.length} imóve${lista.length === 1 ? "l" : "is"}${S.filtros.aba !== "todos" ? ` · ${STATUS[S.filtros.aba]?.rotulo}` : ""}`
    : ""
  const vazio = $("#vazio")
  if (!S.regs.length) {
    vazio.innerHTML = `<h2>Nenhum anúncio ainda</h2><p>Clique em <strong>Buscar agora</strong> para varrer as imobiliárias e portais configurados.</p>`
    vazio.classList.remove("hidden")
  } else if (!lista.length) {
    vazio.innerHTML = `<h2>Nada com esses filtros</h2><p>Tente aumentar o preço, trocar a aba ou limpar a busca por texto.</p>`
    vazio.classList.remove("hidden")
  } else vazio.classList.add("hidden")

  if (S.filtros.view === "mapa") {
    $("#grid").classList.add("hidden")
    $("#mais").classList.add("hidden")
    $("#mapa").classList.remove("hidden")
    renderMapa(lista)
    return
  }
  $("#mapa").classList.add("hidden")
  $("#grid").classList.remove("hidden")
  $("#grid").innerHTML = lista.slice(0, S.limite).map(card).join("")
  $("#mais").classList.toggle("hidden", lista.length <= S.limite)
}

function abas() {
  const base = S.regs.filter((r) => passaFiltros(r, true))
  const cont = { todos: base.filter((r) => r.status !== "descartado").length }
  for (const k of Object.keys(STATUS)) cont[k] = base.filter((r) => r.status === k).length
  const itens = [["todos", "Todos"], ...Object.entries(STATUS).map(([k, v]) => [k, v.rotulo])]
  $("#tabs").innerHTML = itens
    .map(
      ([k, rot]) =>
        `<button class="tab${S.filtros.aba === k ? " ativo" : ""}" data-aba="${k}" type="button">${esc(rot)} <span class="n">${cont[k] ?? 0}</span></button>`,
    )
    .join("")
}

function sincronizarControles() {
  const f = S.filtros
  $("#f-texto").value !== f.texto && ($("#f-texto").value = f.texto)
  $("#f-preco").value = String(f.preco ?? S.config?.aluguel_max ?? 2000)
  $("#f-preco-valor").textContent = `R$ ${brl(Number($("#f-preco").value))}`
  $("#f-base").value = f.base
  $("#f-tipo").value = f.tipo
  $("#f-fonte").value = f.fonte
  $("#f-ordem").value = f.ordem
  for (const id of ["pet", "mob", "vaga", "novos", "inativos"]) $(`#f-${id}`).checked = f[id]
  for (const b of $$("#f-quartos button")) b.classList.toggle("ativo", Number(b.dataset.v) === f.quartos)
  for (const b of $$("#f-view button")) b.classList.toggle("ativo", b.dataset.v === f.view)
}

function melhorContato(r) {
  const cs = r.contatos ?? []
  return cs.find((c) => c.whatsapp && c.papel === "corretor") ?? cs.find((c) => c.whatsapp) ?? cs.find((c) => c.telefone) ?? null
}

function mensagem(r) {
  const tpl = S.config?.mensagem_whatsapp || "Olá! Tenho interesse no imóvel {url}. Ainda está disponível?"
  return tpl
    .replaceAll("{titulo}", r.titulo || TIPO[r.tipo])
    .replaceAll("{ref}", r.referencia ? ` (ref. ${r.referencia})` : "")
    .replaceAll("{bairro}", r.bairro || S.config.cidade)
    .replaceAll("{aluguel}", brl(r.aluguel))
    .replaceAll("{url}", r.url)
    .replaceAll("{anunciante}", r.anunciante || "")
}

function linkWhats(r, contato) {
  return `https://wa.me/${contato.whatsapp}?text=${encodeURIComponent(mensagem(r))}`
}

function quedaPreco(r) {
  const h = r.historico_precos ?? []
  if (h.length < 2) return null
  const a = h.at(-2).aluguel
  const b = h.at(-1).aluguel
  return a != null && b != null && b < a ? a - b : null
}

function fatos(r) {
  const f = []
  if (r.quartos != null) f.push(`${r.quartos} ${r.quartos === 1 ? "quarto" : "quartos"}`)
  if (r.suites) f.push(`${r.suites} suíte${r.suites > 1 ? "s" : ""}`)
  if (r.banheiros != null) f.push(`${r.banheiros} banh.`)
  if (r.vagas != null) f.push(r.vagas ? `${r.vagas} vaga${r.vagas > 1 ? "s" : ""}` : "sem vaga")
  if (r.area) f.push(`${brl(r.area)} m²`)
  return f
}

function tagsBoas(r) {
  const t = []
  if (r.mobiliado) t.push("Mobiliado")
  if (r.aceita_pet) t.push("Aceita pet")
  if (r.aceita_pet === false) t.push("Sem pet")
  for (const g of r.garantias ?? []) t.push(g)
  return t
}

function card(r) {
  const fotos = r.fotos ?? []
  const idx = Math.min(S.fotoIdx.get(r.chave) ?? 0, Math.max(0, fotos.length - 1))
  const outros = outrosDoGrupo(r)
  const queda = quedaPreco(r)
  const contato = melhorContato(r)
  const st = STATUS[r.status] ?? STATUS.novo
  const badges = []
  if (!r.ativo) badges.push(`<span class="badge inativo">Indisponível</span>`)
  else if (daUltimaBusca(r) && r.status === "novo") badges.push(`<span class="badge novo">Novo</span>`)
  if (queda) badges.push(`<span class="badge queda">▼ R$ ${brl(queda)}</span>`)
  if (r.ia?.nota != null) badges.push(`<span class="badge ia">IA ${esc(r.ia.nota)}</span>`)
  const extras = [r.condominio ? `cond. ${brl(r.condominio)}` : null, r.iptu ? `IPTU ${brl(r.iptu)}` : null].filter(Boolean)
  const totalTxt =
    r.total != null && r.aluguel != null && r.total > r.aluguel
      ? `Total <strong>R$ ${brl(r.total)}</strong> · ${extras.join(" · ") || "com taxas"}`
      : r.detalhado
        ? "Sem condomínio/IPTU informados"
        : "Condomínio/IPTU: ver anúncio"
  const acaoContato = contato?.whatsapp
    ? `<a class="btn wa" href="${esc(linkWhats(r, contato))}" target="_blank" rel="noopener" data-whats="${esc(r.chave)}">WhatsApp</a>`
    : contato?.telefone
      ? `<a class="btn" href="tel:${esc(contato.telefone.replace(/\D/g, ""))}">Ligar ${esc(contato.telefone)}</a>`
      : `<a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">Ver anúncio</a>`
  const tags = tagsBoas(r)
  return `
  <article class="card${r.ativo ? "" : " inativo"}${r.status === "descartado" ? " descartado" : ""}" data-chave="${esc(r.chave)}">
    <div class="media" data-abrir="${esc(r.chave)}">
      ${fotos.length ? `<img loading="lazy" src="${esc(fotos[idx])}" alt="" referrerpolicy="no-referrer">` : `<div class="sem-foto">sem fotos</div>`}
      ${fotos.length > 1 ? `<button class="nav prev" data-foto="-1" type="button" aria-label="Foto anterior">‹</button><button class="nav next" data-foto="1" type="button" aria-label="Próxima foto">›</button><span class="contador">${idx + 1}/${fotos.length}</span>` : ""}
      <div class="badges">${badges.join("")}</div>
      <button class="fav${r.status === "interesse" ? " on" : ""}" data-fav="${esc(r.chave)}" type="button" title="Marcar interesse">★</button>
    </div>
    <div class="corpo" data-abrir="${esc(r.chave)}">
      <div class="preco-linha"><span class="valor">${r.aluguel != null ? `R$ ${brl(r.aluguel)}` : "Consulte"} <small>/mês</small></span>
        ${r.status !== "novo" ? `<span class="status-pill" style="--c:${st.cor}">${esc(st.rotulo)}</span>` : ""}</div>
      <div class="total">${totalTxt}</div>
      <div class="titulo">${esc(r.titulo)}</div>
      <div class="fatos"><span><strong>${esc(TIPO[r.tipo])}</strong></span>${fatos(r).map((x) => `<span>${esc(x)}</span>`).join("")}</div>
      <div class="local">📍 ${esc(r.bairro || "Bairro não informado")}</div>
      <div class="anunciante">${esc(r.anunciante || nomeFonte(r.fonte))}${outros.length ? ` · também em ${esc([...new Set(outros.map((o) => nomeFonte(o.fonte)))].join(", "))}` : ""}</div>
      ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag bom">${esc(t)}</span>`).join("")}</div>` : ""}
      ${r.ia?.resumo ? `<div class="ia-resumo">🤖 ${esc(r.ia.resumo)}</div>` : ""}
    </div>
    <div class="acoes">
      ${acaoContato}
      <button class="btn ghost" data-status-rapido="${esc(r.chave)}" type="button" title="${r.status === "descartado" ? "Restaurar" : "Descartar"}">${r.status === "descartado" ? "Restaurar" : "Descartar"}</button>
    </div>
  </article>`
}

// ---------------------------------------------------------------- ações

/** Grava status/notas: no servidor local via API; na página publicada, neste navegador. */
async function gravar(chave, campos) {
  if (!ESTATICO) return api(`/api/imoveis/${encodeURIComponent(chave)}`, { method: "PATCH", body: JSON.stringify(campos) })
  const locais = lsGet(CHAVE_LOCAL, {})
  locais[chave] = { ...locais[chave], ...campos }
  lsSet(CHAVE_LOCAL, locais)
}

async function mudarStatus(chave, status, { silencioso = false } = {}) {
  const r = S.porChave.get(chave)
  if (!r) return
  const anterior = r.status
  r.status = status
  render()
  if (S.aberto === chave) abrirDetalhe(chave, { manterScroll: true })
  try {
    await gravar(chave, { status })
    if (!silencioso) toast(`Marcado como ${STATUS[status].rotulo.toLowerCase()}`, { rotulo: "Desfazer", fn: () => mudarStatus(chave, anterior, { silencioso: true }) })
  } catch (e) {
    r.status = anterior
    render()
    toast(`Não consegui salvar: ${e.message}`)
  }
}

const salvarNotas = debounce(async (chave, notas) => {
  try {
    await gravar(chave, { notas })
    const el = $("#notas-status")
    if (el) el.textContent = "salvo"
  } catch (e) {
    toast(`Não consegui salvar a nota: ${e.message}`)
  }
}, 600)

function aoContatar(chave) {
  const r = S.porChave.get(chave)
  if (r && (r.status === "novo" || r.status === "interesse")) mudarStatus(chave, "contatado")
}

// ---------------------------------------------------------------- detalhe

function abrirDetalhe(chave, { manterScroll = false } = {}) {
  const r = S.porChave.get(chave)
  if (!r) return
  S.aberto = chave
  const dlg = $("#dlg-detalhe")
  const scroll = manterScroll ? $(".det-scroll", dlg)?.scrollTop : 0
  const fotos = r.fotos ?? []
  const idx = Math.min(S.fotoIdx.get(`det:${chave}`) ?? 0, Math.max(0, fotos.length - 1))
  const st = STATUS[r.status] ?? STATUS.novo
  const outros = outrosDoGrupo(r)
  const m2 = r.area && r.aluguel ? r.aluguel / r.area : null
  const contatos = r.contatos ?? []

  dlg.innerHTML = `
  <div class="det">
    <div class="det-top">
      <span class="status-pill" style="--c:${st.cor}">${esc(st.rotulo)}</span>
      <h2 title="${esc(r.titulo)}">${esc(r.titulo)}</h2>
      <a class="btn small" href="${esc(r.url)}" target="_blank" rel="noopener">Anúncio ↗</a>
      <button class="btn small ghost" data-fechar type="button" aria-label="Fechar">✕</button>
    </div>
    <div class="det-scroll">
      ${
        fotos.length
          ? `<div class="galeria"><img src="${esc(fotos[idx])}" alt="" referrerpolicy="no-referrer">
             ${fotos.length > 1 ? `<button class="nav prev" data-det-foto="-1" type="button">‹</button><button class="nav next" data-det-foto="1" type="button">›</button><span class="contador">${idx + 1}/${fotos.length}</span>` : ""}</div>
             ${fotos.length > 1 ? `<div class="thumbs">${fotos.map((f, i) => `<img src="${esc(f)}" data-det-thumb="${i}" class="${i === idx ? "ativo" : ""}" loading="lazy" alt="" referrerpolicy="no-referrer">`).join("")}</div>` : ""}`
          : ""
      }
      ${!r.ativo ? `<div class="sec"><div class="alerta">Este anúncio não apareceu na última busca completa da fonte (desde ${esc(dataBR(r.inativo_desde))}) - provavelmente foi alugado ou saiu do ar.</div></div>` : ""}
      <div class="sec">
        <h3>Custos mensais</h3>
        <div class="custos">
          <div class="custo"><span>Aluguel</span><strong>R$ ${brl(r.aluguel)}</strong></div>
          <div class="custo"><span>Condomínio</span><strong>${r.condominio != null ? `R$ ${brl(r.condominio)}` : "—"}</strong></div>
          <div class="custo"><span>IPTU (mês)</span><strong>${r.iptu != null ? `R$ ${brl(r.iptu)}` : "—"}</strong></div>
          <div class="custo destaque"><span>Total</span><strong>R$ ${brl(r.total ?? r.aluguel)}</strong></div>
          ${m2 ? `<div class="custo"><span>R$/m²</span><strong>${brl(m2, 2)}</strong></div>` : ""}
        </div>
        ${r.condominio == null && r.iptu == null ? `<p class="muted small">Condomínio e IPTU não informados pela fonte - confirme com o anunciante.</p>` : ""}
      </div>
      <div class="sec">
        <h3>Contato</h3>
        ${
          contatos.length
            ? contatos
                .map(
                  (c) => `<div class="contato">
              <div class="quem"><strong>${esc(c.nome || r.anunciante || "Anunciante")}</strong>
                <span>${esc({ corretor: "Corretor(a)", imobiliaria: "Imobiliária", anunciante: "Anunciante" }[c.papel] || "")}${c.creci ? ` · CRECI ${esc(c.creci)}` : ""}${c.email ? ` · ${esc(c.email)}` : ""}</span></div>
              ${c.whatsapp ? `<a class="btn wa small" href="${esc(linkWhats(r, c))}" target="_blank" rel="noopener" data-whats="${esc(r.chave)}">WhatsApp</a>` : ""}
              ${c.telefone ? `<a class="btn small" href="tel:${esc(c.telefone.replace(/\D/g, ""))}">${esc(c.telefone)}</a>` : ""}
              ${c.email ? `<a class="btn small ghost" href="mailto:${esc(c.email)}?subject=${encodeURIComponent(`Interesse no imóvel ${r.referencia ? "ref. " + r.referencia : ""}`)}&body=${encodeURIComponent(mensagem(r))}">E-mail</a>` : ""}
              ${!c.telefone && !c.whatsapp && !c.email ? `<span class="muted small">peça pelo nome na imobiliária</span>` : ""}
            </div>`,
                )
                .join("")
            : `<p class="muted">Sem contato capturado - use o link do anúncio.</p>`
        }
        <button class="btn small ghost" data-copiar-msg type="button">Copiar mensagem pronta</button>
      </div>
      <div class="sec">
        <h3>Seu acompanhamento${ESTATICO ? ` <small class="muted">· fica salvo só neste navegador</small>` : ""}</h3>
        <div class="status-botoes">
          ${Object.entries(STATUS)
            .map(([k, v]) => `<button class="btn small${r.status === k ? " ativo" : ""}" style="--c:${v.cor}" data-set-status="${k}" type="button">${esc(v.rotulo)}</button>`)
            .join("")}
        </div>
        <p class="muted small" style="margin:10px 0 4px">Notas (visita, perguntas, impressões) <span id="notas-status"></span></p>
        <textarea class="notas" data-notas="${esc(r.chave)}" placeholder="Ex.: visita sexta 18h; perguntar sobre caução e pintura na saída">${esc(r.notas || "")}</textarea>
      </div>
      ${
        r.ia
          ? `<div class="sec"><h3>Análise da IA ${r.ia.nota != null ? `· nota ${esc(r.ia.nota)}` : ""}</h3>
          <p style="margin:0">${esc(r.ia.resumo)}</p>
          ${(r.ia.alertas ?? []).map((a) => `<div class="alerta">⚠ ${esc(a)}</div>`).join("")}
          <p class="muted small">por /scrape no Claude Code · ${esc(dataBR(r.ia.data))}</p></div>`
          : ""
      }
      <div class="sec">
        <h3>Imóvel</h3>
        <div class="dados">
          <div class="dado"><span>Tipo</span><strong>${esc(TIPO[r.tipo])}</strong></div>
          <div class="dado"><span>Quartos</span><strong>${r.quartos ?? "—"}</strong></div>
          <div class="dado"><span>Suítes</span><strong>${r.suites ?? "—"}</strong></div>
          <div class="dado"><span>Banheiros</span><strong>${r.banheiros ?? "—"}</strong></div>
          <div class="dado"><span>Vagas</span><strong>${r.vagas ?? "—"}</strong></div>
          <div class="dado"><span>Área</span><strong>${r.area ? `${brl(r.area)} m²` : "—"}</strong></div>
          <div class="dado"><span>Mobiliado</span><strong>${r.mobiliado == null ? "?" : r.mobiliado ? "Sim" : "Não"}</strong></div>
          <div class="dado"><span>Aceita pet</span><strong>${r.aceita_pet == null ? "?" : r.aceita_pet ? "Sim" : "Não"}</strong></div>
        </div>
        <p style="margin:10px 0 0">📍 ${esc([r.endereco, r.bairro, r.cidade].filter(Boolean).join(", ") || "Endereço não informado")}${r.referencia ? ` · ref. ${esc(r.referencia)}` : ""}</p>
        ${(r.garantias ?? []).length ? `<p style="margin:6px 0 0">Garantias citadas: ${esc(r.garantias.join(", "))}</p>` : ""}
        ${(r.caracteristicas ?? []).length ? `<div class="tags" style="margin-top:8px">${r.caracteristicas.map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>` : ""}
        ${!r.detalhado && !ESTATICO ? `<p style="margin-top:10px"><button class="btn small" data-carregar-detalhe type="button">Carregar detalhes do anúncio</button></p>` : ""}
      </div>
      ${
        r.lat != null && r.lng != null
          ? `<div class="sec"><h3>Localização ${r.coord_aprox ? "(aproximada - centro do bairro)" : ""}</h3>
          <iframe class="mapa-mini" loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${r.lng - 0.012}%2C${r.lat - 0.008}%2C${r.lng + 0.012}%2C${r.lat + 0.008}&layer=mapnik&marker=${r.lat}%2C${r.lng}"></iframe>
          <p class="small"><a href="https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}" target="_blank" rel="noopener">Abrir no Google Maps</a></p></div>`
          : ""
      }
      ${r.descricao ? `<div class="sec"><h3>Descrição</h3><p class="descricao">${esc(r.descricao)}</p></div>` : ""}
      <div class="sec">
        <h3>Onde está anunciado</h3>
        <div class="links-fonte">
          ${[r, ...outros]
            .map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener"><span>${esc(nomeFonte(o.fonte))}${o.anunciante && o.anunciante !== nomeFonte(o.fonte) ? ` · ${esc(o.anunciante)}` : ""}</span><span>R$ ${brl(o.aluguel)} ↗</span></a>`)
            .join("")}
        </div>
      </div>
      <div class="sec historico">
        <h3>Histórico</h3>
        <p style="margin:0">Visto pela primeira vez em ${esc(dataBR(r.primeira_vez))} · última vez ${esc(quando(r.ultima_vez))}${r.atualizado_em ? ` · atualizado na fonte em ${esc(dataBR(r.atualizado_em))}` : ""}${r.publicado_em ? ` · publicado em ${esc(dataBR(r.publicado_em))}` : ""}</p>
        ${(r.historico_precos ?? []).length > 1 ? `<p style="margin:6px 0 0">Preços: ${r.historico_precos.map((h) => `${esc(dataBR(h.data))} R$ ${brl(h.aluguel)}`).join(" → ")}</p>` : ""}
      </div>
    </div>
  </div>`
  if (!dlg.open) dlg.showModal()
  if (manterScroll) $(".det-scroll", dlg).scrollTop = scroll
  history.replaceState(null, "", `#/imovel/${encodeURIComponent(chave)}`)
}

/** Links diretos: http://localhost:3000/#/imovel/<chave> abre a gaveta do anúncio. */
function abrirDoEndereco() {
  if (location.hash === "#/outros") return abrirOutros()
  const m = location.hash.match(/^#\/imovel\/(.+)$/)
  if (m && S.porChave.has(decodeURIComponent(m[1]))) abrirDetalhe(decodeURIComponent(m[1]))
}

function fotoDetalhe(delta, absoluto = null) {
  const r = S.porChave.get(S.aberto)
  if (!r?.fotos?.length) return
  const k = `det:${r.chave}`
  const atual = S.fotoIdx.get(k) ?? 0
  const n = r.fotos.length
  S.fotoIdx.set(k, absoluto ?? (atual + delta + n) % n)
  const i = S.fotoIdx.get(k)
  const dlg = $("#dlg-detalhe")
  $(".galeria img", dlg).src = r.fotos[i]
  const cont = $(".galeria .contador", dlg)
  if (cont) cont.textContent = `${i + 1}/${n}`
  $$(".thumbs img", dlg).forEach((t, j) => t.classList.toggle("ativo", j === i))
  $(".thumbs img.ativo", dlg)?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

async function carregarDetalhe(chave) {
  const btn = $("[data-carregar-detalhe]")
  if (btn) {
    btn.disabled = true
    btn.textContent = "Carregando…"
  }
  try {
    const { data } = await api(`/api/imoveis/${encodeURIComponent(chave)}/detalhe`, { method: "POST" })
    Object.assign(S.porChave.get(chave), data)
    render()
    abrirDetalhe(chave, { manterScroll: true })
  } catch (e) {
    toast(e.message)
    if (btn) {
      btn.disabled = false
      btn.textContent = "Carregar detalhes do anúncio"
    }
  }
}

// ---------------------------------------------------------------- mapa

async function garantirLeaflet() {
  if (window.L) return
  const css = document.createElement("link")
  css.rel = "stylesheet"
  css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  document.head.append(css)
  await new Promise((ok, falha) => {
    const s = document.createElement("script")
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    s.onload = ok
    s.onerror = () => falha(new Error("não consegui carregar o Leaflet (sem internet?)"))
    document.head.append(s)
  })
}

async function renderMapa(lista) {
  try {
    await garantirLeaflet()
  } catch (e) {
    $("#mapa").innerHTML = `<div class="vazio">${esc(e.message)}</div>`
    return
  }
  const L = window.L
  if (!S.mapa) {
    S.mapa = L.map("mapa", { scrollWheelZoom: true })
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap",
    }).addTo(S.mapa)
    S.camadaMapa = L.layerGroup().addTo(S.mapa)
  }
  S.camadaMapa.clearLayers()
  const pts = []
  const cor = { novo: "#2563eb", interesse: "#d97706", contatado: "#7c3aed", visita: "#0891b2", proposta: "#16a34a", descartado: "#6b7280" }
  for (const r of lista) {
    if (r.lat == null || r.lng == null) continue
    // Pinos aproximados (centro do bairro) ganham um leve deslocamento para não empilhar.
    const jit = r.coord_aprox ? () => (Math.random() - 0.5) * 0.004 : () => 0
    const lat = r.lat + jit()
    const lng = r.lng + jit()
    pts.push([lat, lng])
    const m = L.circleMarker([lat, lng], {
      radius: r.coord_aprox ? 7 : 9,
      color: cor[r.status] ?? "#2563eb",
      weight: 2,
      fillOpacity: r.coord_aprox ? 0.25 : 0.75,
      dashArray: r.coord_aprox ? "3 3" : null,
    })
    m.bindPopup(
      `${r.fotos?.[0] ? `<img class="popup-img" src="${esc(r.fotos[0])}" referrerpolicy="no-referrer">` : ""}
       <strong>R$ ${brl(r.aluguel)}</strong> · ${esc(TIPO[r.tipo])}${r.quartos != null ? ` · ${r.quartos}q` : ""}<br>
       ${esc(r.bairro || "")}${r.coord_aprox ? " <em>(aprox.)</em>" : ""}<br>
       <button class="btn small" data-abrir="${esc(r.chave)}" type="button" style="margin-top:6px">Ver detalhes</button>`,
    )
    m.addTo(S.camadaMapa)
  }
  setTimeout(() => {
    S.mapa.invalidateSize()
    if (pts.length) S.mapa.fitBounds(pts, { padding: [30, 30], maxZoom: 15 })
    else S.mapa.setView([-22.885, -48.445], 13)
  }, 30)
  $("#contagem").textContent += ` · ${pts.length} no mapa (${lista.length - pts.length} sem localização)`
}

// ---------------------------------------------------------------- busca (scrape)

async function buscarAgora() {
  if (ESTATICO) {
    // Sem servidor: a busca roda no GitHub Actions (botão "Run workflow" nessa página).
    window.open(S.atualizarUrl, "_blank", "noopener")
    toast('No GitHub, clique em "Run workflow" - em alguns minutos recarregue esta página')
    return
  }
  try {
    const { status, data } = await api("/api/buscar", { method: "POST", body: JSON.stringify({}) })
    if (status === 409 && !data.rodando) {
      toast(data.error || "Não consegui iniciar a busca")
      return
    }
    acompanharBusca()
  } catch (e) {
    toast(`Erro ao iniciar a busca: ${e.message}`)
  }
}

function acompanharBusca() {
  const btn = $("#btn-buscar")
  btn.disabled = true
  btn.classList.add("spin")
  $("span", btn).textContent = "Buscando…"
  $("#progresso").classList.remove("hidden")
  clearInterval(S.polling)
  S.polling = setInterval(async () => {
    try {
      const { data: job } = await api("/api/buscar")
      const itens = Object.values(job.progresso || {})
      $("#progresso").innerHTML =
        `<strong>Buscando:</strong>` +
        itens
          .map((p) => {
            const txt =
              p.fase === "detalhando"
                ? `lendo anúncios ${p.detalhados}/${p.paraDetalhar}`
                : p.fase === "ok"
                  ? `${p.encontrados} anúncios`
                  : p.fase === "erro"
                    ? "erro"
                    : p.fase
            return `<span class="item ${p.fase}" title="${esc(p.msg || "")}"><span class="dot"></span>${esc(p.nome)}: ${esc(txt)}</span>`
          })
          .join("")
      if (!job.rodando) {
        clearInterval(S.polling)
        btn.disabled = false
        btn.classList.remove("spin")
        $("span", btn).textContent = "Buscar agora"
        setTimeout(() => $("#progresso").classList.add("hidden"), 4000)
        if (job.erro) toast(`Busca falhou: ${job.erro}`)
        else if (job.ultimo) {
          const novos = job.ultimo.novos?.length ?? 0
          const falhas = Object.entries(job.ultimo.fontes || {}).filter(([, r]) => !r.ok).map(([id]) => nomeFonte(id))
          toast(`${novos ? `${novos} anúncio(s) novo(s)` : "Nenhum anúncio novo"}${falhas.length ? ` · falhou: ${falhas.join(", ")}` : ""}`)
        }
        await carregar()
      }
    } catch {
      /* servidor reiniciando: tenta de novo no próximo ciclo */
    }
  }, 1200)
}

// ---------------------------------------------------------------- outros sites

function abrirOutros() {
  const c = S.config
  const inativas = c.fontes.filter((f) => !f.ativo)
  $("#dlg-outros").innerHTML = `
  <div class="conteudo">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <h2 style="font-size:18px">Outros lugares para procurar</h2>
      <button class="btn small ghost" data-fechar type="button">✕</button>
    </div>
    <p class="muted" style="margin:0">Estes sites bloqueiam robôs, exigem login ou ainda não têm adaptador - abra manualmente (os links já vêm filtrados quando o site permite).</p>
    ${c.busca_manual
      .map(
        (l) => `<div class="item-link"><div><strong>${esc(l.nome)}</strong><small>${esc(l.obs || "")}</small></div>
      <a class="btn small" href="${esc(l.url)}" target="_blank" rel="noopener">Abrir ↗</a></div>`,
      )
      .join("")}
    ${
      inativas.length
        ? `<h3 style="font-size:14px;margin-top:6px">Fontes configuradas mas desativadas</h3>
      ${inativas.map((f) => `<div class="item-link"><div><strong>${esc(f.nome)}</strong><small>${esc(f.aviso || "desativada em config/busca.json")}</small></div></div>`).join("")}
      <p class="muted small" style="margin:0">Para ativar, mude <code>"ativo": false</code> para <code>true</code> em <code>config/busca.json</code>.</p>`
        : ""
    }
  </div>`
  $("#dlg-outros").showModal()
}

// ---------------------------------------------------------------- eventos

function ligarEventos() {
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-aba]")
    if (!b) return
    S.filtros.aba = b.dataset.aba
    S.limite = 60
    render()
  })
  $("#f-texto").addEventListener(
    "input",
    debounce((e) => {
      S.filtros.texto = e.target.value.trim()
      render()
    }, 200),
  )
  $("#f-preco").addEventListener("input", (e) => {
    S.filtros.preco = Number(e.target.value)
    $("#f-preco-valor").textContent = `R$ ${brl(S.filtros.preco)}`
  })
  $("#f-preco").addEventListener("change", () => render())
  for (const [id, campo] of [
    ["f-base", "base"],
    ["f-tipo", "tipo"],
    ["f-fonte", "fonte"],
    ["f-ordem", "ordem"],
  ]) {
    $(`#${id}`).addEventListener("change", (e) => {
      S.filtros[campo] = e.target.value
      render()
    })
  }
  for (const id of ["pet", "mob", "vaga", "novos", "inativos"]) {
    $(`#f-${id}`).addEventListener("change", (e) => {
      S.filtros[id] = e.target.checked
      render()
    })
  }
  $("#f-quartos").addEventListener("click", (e) => {
    const b = e.target.closest("button")
    if (!b) return
    S.filtros.quartos = Number(b.dataset.v)
    render()
  })
  $("#f-view").addEventListener("click", (e) => {
    const b = e.target.closest("button")
    if (!b) return
    S.filtros.view = b.dataset.v
    render()
  })
  $("#mais button").addEventListener("click", () => {
    S.limite += 60
    render()
  })
  $("#btn-buscar").addEventListener("click", buscarAgora)
  $("#btn-outros").addEventListener("click", abrirOutros)

  // Delegação: cards, mapa e gaveta.
  document.addEventListener("click", (e) => {
    const t = e.target
    const foto = t.closest("[data-foto]")
    if (foto) {
      e.stopPropagation()
      const chave = foto.closest(".card").dataset.chave
      const r = S.porChave.get(chave)
      const n = r.fotos.length
      const i = ((S.fotoIdx.get(chave) ?? 0) + Number(foto.dataset.foto) + n) % n
      S.fotoIdx.set(chave, i)
      const media = foto.closest(".media")
      $("img", media).src = r.fotos[i]
      $(".contador", media).textContent = `${i + 1}/${n}`
      return
    }
    const fav = t.closest("[data-fav]")
    if (fav) {
      const r = S.porChave.get(fav.dataset.fav)
      mudarStatus(r.chave, r.status === "interesse" ? "novo" : "interesse")
      return
    }
    const rapido = t.closest("[data-status-rapido]")
    if (rapido) {
      const r = S.porChave.get(rapido.dataset.statusRapido)
      mudarStatus(r.chave, r.status === "descartado" ? "novo" : "descartado")
      return
    }
    const whats = t.closest("[data-whats]")
    if (whats) {
      aoContatar(whats.dataset.whats)
      return
    }
    const abrir = t.closest("[data-abrir]")
    if (abrir) {
      abrirDetalhe(abrir.dataset.abrir)
      return
    }
    if (t.closest("[data-fechar]")) {
      t.closest("dialog")?.close()
      return
    }
    const df = t.closest("[data-det-foto]")
    if (df) return fotoDetalhe(Number(df.dataset.detFoto))
    const th = t.closest("[data-det-thumb]")
    if (th) return fotoDetalhe(0, Number(th.dataset.detThumb))
    const ss = t.closest("[data-set-status]")
    if (ss) return mudarStatus(S.aberto, ss.dataset.setStatus)
    if (t.closest("[data-carregar-detalhe]")) return carregarDetalhe(S.aberto)
    if (t.closest("[data-copiar-msg]")) {
      const r = S.porChave.get(S.aberto)
      navigator.clipboard?.writeText(mensagem(r)).then(
        () => toast("Mensagem copiada"),
        () => toast("Não consegui copiar"),
      )
    }
  })

  document.addEventListener("input", (e) => {
    const ta = e.target.closest?.("[data-notas]")
    if (!ta) return
    const r = S.porChave.get(ta.dataset.notas)
    if (r) r.notas = ta.value
    const el = $("#notas-status")
    if (el) el.textContent = "salvando…"
    salvarNotas(ta.dataset.notas, ta.value)
  })

  // Clique no fundo fecha os diálogos.
  for (const dlg of $$("dialog")) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close()
    })
    dlg.addEventListener("close", () => {
      if (dlg.id !== "dlg-detalhe") return
      S.aberto = null
      history.replaceState(null, "", location.pathname + location.search)
    })
  }
  document.addEventListener("keydown", (e) => {
    if (!S.aberto || !$("#dlg-detalhe").open) return
    if (e.target.closest?.("textarea, input")) return
    if (e.key === "ArrowRight") fotoDetalhe(1)
    if (e.key === "ArrowLeft") fotoDetalhe(-1)
  })
}

// ---------------------------------------------------------------- início

S.filtros = { ...FILTROS_PADRAO, ...lsGet("busca-imoveis:filtros", {}) }
const params = new URLSearchParams(location.search)
if (params.get("view") === "mapa" || params.get("view") === "lista") S.filtros.view = params.get("view")
ligarEventos()
window.addEventListener("hashchange", abrirDoEndereco)
carregar()
  .then(abrirDoEndereco)
  .catch((e) => {
  $("#subtitulo").textContent = "erro ao carregar"
  $("#vazio").innerHTML = ESTATICO
    ? `<h2>Não consegui carregar os anúncios</h2><p>${esc(e.message)}</p><p>Recarregue a página em alguns minutos.</p>`
    : `<h2>Não consegui falar com o servidor</h2><p>${esc(e.message)}</p><p>Ele está rodando? <code>bun run app</code></p>`
  $("#vazio").classList.remove("hidden")
})
