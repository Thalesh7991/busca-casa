# Plataformas e fontes - referência de manutenção

Quando uma fonte quebrar (`bun run portal saude` acusa "degradado"/"sem resultados"), este é o mapa: de onde vêm os dados, como paginar e onde estão as âncoras de parsing no código. Tudo verificado ao vivo em 28/09/2026.

Levantamento de Botucatu/SP (aluguel):

| Fonte | Plataforma | robots.txt | Situação |
|---|---|---|---|
| Robuste, Pontes, Molina, Dupla | msys | `Allow: /` | ativas |
| S.A Imóveis, Rede Concreto | KSI | `Allow: /` | ativas |
| Chaves na Mão | próprio (Next.js) | só sem query ou `?pg=2..5` | ativa (agregador) |
| Expande, Essencial, Amelia Ramos (Lar) | Kenlo | `User-agent: *` → `Disallow: /` | adaptador pronto, **desativadas** |
| ZAP, Viva Real, OLX, Imovelweb | - | bloqueio Cloudflare (403) | só link manual |
| Mercado Livre Imóveis | - | exige verificação de conta | só link manual |
| QuintoAndar | - | liberado, mas **não atende Botucatu** | - |
| Daiane Bonan | Jetimob | - | sem adaptador (anúncios aparecem no Chaves na Mão e na S.A) |
| Cecília Barros | ImobiBrasil | - | sem adaptador (aparece no Chaves na Mão) |
| RE/MAX Invest, ADM | - | domínios próprios fora do ar | cobertas pelo Chaves na Mão |

User-Agent de todas as requisições: `Mozilla/5.0 (compatible; busca-imoveis/1.0; uso pessoal)`, com intervalo mínimo de 350 ms por host (`BUSCA_IMOVEIS_GAP_MS`) e backoff em 429/5xx (`src/lib/http.ts`).

---

## msys

Sites Next.js da msysimob (`__NEXT_DATA__` com `"imob":"msys_imob_<nome>"`).

**Site/cidade** - `GET {site}/alugar/{cidade-slug}-{uf}` (ex.: `/alugar/botucatu-sp`):
`props.initialProps.pageProps.template`:
- `data.initialPlaces[].city.idtCity` → id interno da cidade (varia por imobiliária: 5 na Robuste, 1 na Pontes)
- `imobInfo` → `phone`, `phone2`, `email`, `whatsapp` (string **ou** lista de `{number,title}`)
- `requests.allCharacteristics[]` → `{idtCharacteristics, desCharacteristics}` (ids globais da plataforma)

**Busca** - `POST {site}/api/service/consult`, corpo JSON (o mesmo que a página envia):
```json
{ "type": "L", "idtCityList": [5], "toPrice": 2000, "start": 0, "numRows": 50,
  "getAccess": true, "post": true, "sortList": ["dtaUpdate desc"],
  "fieldList": ["idtProperty", "valLocation", "..."], "jsonPhotosNum": 40 }
```
→ `{ response: { numFound, docs: [...] } }`. `type: "L"` inclui imóveis "venda e locação" (`indType: "SL"`). Sem `fieldList` a API devolve só um subconjunto de campos.

Campos: `valLocation` (aluguel), `valCondominium(Calculated)`, `valMonthIptu`/`valIptuCalculated` (0 = não informado), `prop_char_5` dormitórios, `prop_char_6` suítes, `prop_char_176` total de banheiros, `totalGarages`, `prop_char_95` área útil / `_2` total / `_1` construída, `idtsCharacteristics` (`"|27||194|"`: 27 mobília, 467 semimobiliado, 194 aceita pet, 621 não aceita pet), `jsonPhotos` (string JSON), `desTitleSite`, `desInformationSite`, `dtaUpdate`, `latitude`/`longitude` (valem se `flgShowMapSite`).

**Detalhe** - `GET {site}/imovel/{id}` redireciona (301) para a URL canônica `/imovel/{locacao|venda-e-locacao}/{categoria}/{cidade}/{bairro[-condominio]}/{id}`. `template.data.property` (mesmos campos + `jsonCharacteristics`) e `template.data.captivators[]` → corretor: `namPerson`, `creci`, `desPhone`, `desEmail`.

**Âncoras:** `src/portais/msys.ts` → `siteInfo`, `docToImovel`, `parseDetailPage`, `FIELD_LIST`, `CH`.

---

## KSI

Sites server-side em ISO-8859-1 (assinaturas: `kurole_include`, `/ksi/clientes/`).

**Busca** - `GET {site}/alugar/{Cidade}?vma={max}&pag={n}` (Cidade em Title-Case sem acento, hífens: `Botucatu`, `Lencois-Paulista`). O `<title>` traz o total ("120 imóveis em Botucatu, SP até R$ 2.000,00"). Cards: `<div class="card card-imo"`:
- `Cód. <strong>{id}</strong>`, link `href="alugar/{Cidade}/{Tipo}/{Sub}/{Bairro}/{id}"`
- fotos `data-flickity-lazyload-src` (`/foto_thumb/` → trocar por `/foto_/` para tamanho cheio)
- preço `<div class="card-valores"><div>R$ 1.600,00 L</div>` (`L` locação, `V` venda)
- `<h2 title="Apartamento - KITNET">`, `card-bairro-cidade-texto` ("Jardim Paraíso - Botucatu/SP"), `card-texto` (descrição)
- atributos por `title="1 Dormitório"`, `"1 Banheiro"`, `"40.00 M²"`

O total do título às vezes excede em 1-4 os cards exibidos (destaques repetidos entre páginas); `completo` = percorreu até uma página sem anúncios novos.

**Detalhe** - a própria URL do card: JSON-LD `Product` (fotos em tamanho cheio, descrição com entidades HTML, preço) + nós de texto "Aluguel" / "Condomínio" / "IPTU" / "Total / Mês", "Itens do Imóvel", "CORRETOR RESPONSÁVEL" (nome + CRECI; telefone é o da imobiliária, link `tel:`). Os `{lat, lng}` da página são **dos escritórios**, não do imóvel - ignorados.

**Âncoras:** `src/portais/ksi.ts` → `parseTotal`, `parseCard`, `parseDetailPage` (`valueAfter`, `valueBefore`, `sectionItems`).

---

## Chaves na Mão

Portal agregador (Next.js app router). **robots.txt:** `Disallow: /*?*` exceto `?pg=2` a `?pg=5` → só 5 páginas × 15 anúncios por caminho e nenhum filtro por query (preço é filtrado localmente).

**Busca** - `GET /{tipo}-para-alugar/{uf}-{cidade}/[?pg=N]` para `apartamentos`, `kitnet`, `casas`, `casas-em-condominio`, `coberturas`. JSON-LD `RealEstateListing` → `offers.numberOfItems` (total do caminho) e `offers.itemListElement[]` (`Offer`: `name`, `url` com `/id-{n}/`, `price`, `itemOffered.{numberOfBedrooms, numberOfBathroomsTotal, floorSize, address}`, `offeredBy.name`). Páginas com poucos resultados completam a lista com anúncios de outros tipos/cidades - filtrar pela URL (`-para-alugar-` e `-{uf}-{cidade}-`). Caminhos por bairro também existem (`/apartamentos-para-alugar/sp-botucatu/centro/`) se um dia for preciso passar do limite de 75.

**Detalhe** - `GET /imovel/.../id-{n}/`: JSON-LD `@graph` → `RealEstateListing` (descrição, `datePosted`, `about.image[]`, `about.offers.offeredBy.{name, telephone}`, `amenityFeature[]`) + payload RSC (`self.__next_f.push`, JSON escapado): `"reference"` (código na imobiliária - liga o duplicado com a fonte direta), `"condominiumFee"`, `"iptuValue"`, `"petFriendly"`, `"whatsapp":[...]`, `"creci"`, `"bedrooms|suites|bathrooms|garages":{"count":n}`, `neighborhood.geoposition` (centro do bairro → `coord_aprox`).

**Âncoras:** `src/portais/chavesnamao.ts` → `PATHS`, `parseListPage`, `parseDetailPage`, `rscField`.

---

## Kenlo

Sites Marko.js (`window.markoVars`, imagens `img.kenlo.io`). **robots.txt:** `User-agent: *` → `Disallow: /` (liberado só para buscadores). Fontes Kenlo ficam `"ativo": false`; ativar é decisão do usuário, para uso pessoal.

**Busca** - `GET {site}/imoveis/para-alugar/{cidade}?preco-de-locacao=0~{max}&pagina={n}`. Estado em `window.markoVars['listings-xxxx'] = {...}` → `settings.listings = { count, data: [...] }` (12 por página). Campos: `property_full_reference` ("AP1504-EXPJ"), `rent_price` [min,max], `total_rent`, `bedrooms`/`suites`/`bathrooms`/`garages`/`area` ([min,max]), `neighborhood_display`, `photos[].picture_full`, `amenities` (`FURNISHED`, `PET_FRIENDLY`...), `rent_guarantee` (`GUARANTOR`, `BOND_INSURANCE`...), `updated_at`, `url`. Contatos da imobiliária: `offices[].phones[]`, `website.chat_whatsapp_phone`.

**Detalhe** - `markoVars['listing-details-xxxx'].settings.listing[0]` → `brokers[]` (`broker_name`, `broker_mobile_phone`, `broker_whatsapp`, `broker_credential` = CRECI, `broker_email`), `condo_fees`, `listing_description`.

**Âncoras:** `src/portais/kenlo.ts` → `parseMarkoVars`, `listingToImovel`, `agencyContacts`, `parseDetailPage`.

---

## Duplicados entre fontes (`src/dedupe.ts`)

1. **Referência:** anúncio do agregador cujo anunciante casa com uma fonte configurada (nome ou `apelidos`, via `normalizeName`) e cuja `reference` é igual ao id/referência da fonte direta (msys: `idtProperty`; KSI: código; Kenlo: `property_reference`).
2. **Atributos:** fontes diferentes, mesmo aluguel, mesma família de tipo, mesmo bairro normalizado, área conhecida nos dois e compatível (±2 m² ou 4%), mesmos quartos, banheiros/vagas/condomínio compatíveis quando conhecidos.

Um grupo nunca junta dois anúncios da mesma fonte (evita que kitnets iguais do mesmo prédio contaminem o grupo por transitividade).
