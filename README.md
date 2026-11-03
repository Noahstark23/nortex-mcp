# MuseNortex — MCP connector for Nortex (open source)

This repository contains the Model Context Protocol (MCP) server built for
**MuseNortex**, a submission to the Meta Global AI Developer Hackathon
(Startup track). It connects **Nortex** — a business-management SaaS for small
shops in Nicaragua (invoicing, inventory, payroll) — to AI assistants through
10 read-only tools with short, voice-ready answers in Spanish (Nicaraguan
voseo): today's sales, sales over a period, low stock, product prices, open
inventory counts, and product-usage help grounded in the official manual.

The server is strictly read-only. Each business connects its own AI with its
own revocable AI-access token generated inside Nortex, and can only ever see
its own business's data.

The Nortex platform itself is proprietary and is **not** part of this
repository; this connector talks to it over HTTP.

License: MIT — see [LICENSE](LICENSE).

---

# nortex-mcp — servidor MCP read-only para Nortex (F2 + F4 + F5 + F6 + F7 + F7.1)

Servidor MCP (stdio + Streamable HTTP) con 10 tools de solo lectura (9 de datos + `resolver_duda`, dudas de uso) que devuelven
respuestas cortas en **voseo nicaragüense**, listas para voz. Es el transporte que
usará la voz de MuseNortex (T6): las tools del hackatón son capabilities de este
mismo MCP, no un servicio aparte.

**Ticket:** T4-04 (track T4 mcp-readonly) · **Fases:** F2 — catálogo v1 completo
+ rate limit + auditoría · F4 — transporte Streamable HTTP · F5 —
`informe_ventas`, el Reporte integral a pedido (v0.3.0) · F6 — `resolver_duda`,
NortexGPT: dudas de uso con fuentes oficiales (v0.4.0) · F7 — auth por
cliente: cada negocio conecta SU IA con SU cuenta Nortex (v0.5.0) · F7.1 — el
modo cliente acepta el «acceso para IA» `nxt_` que el dueño genera en Nortex (v0.5.1).

## Límites (leer antes de usar)

- **Mocks, no staging.** El backend es sintético (`src/mock.ts`), pero desde el
  2026-10-14 las FORMAS (rutas, parámetros, shapes de respuesta) están
  **verificadas contra el código del monolito** `nortex.20` (ver mapa abajo).
  La paridad contra staging vivo sigue siendo F3 (requiere JWT de staging —
  bloqueado, paso de cuenta de Noel).
- **Sin OAuth.** Desde F7.1 el cliente se autentica con el «acceso para IA»
  `nxt_` que genera en Nortex (ver «Para clientes: conectá tu IA»; requiere el
  monolito con la rama `stark/mcp-access-token` desplegada). El JWT de sesión de
  F7 sigue aceptado. OAuth / conector publicable sigue pendiente (requiere OK de Noel).
- **Solo lectura.** Ninguna tool escribe. `detalle_venta` es fail closed: responde
  un string fijo porque su endpoint devuelve HTML, no JSON (ver abajo).
- **`precio_producto` es base NIO.** La extensión a USD vive en T6-10
  (`precio_dolares`, MuseNortex) — esta tool no la duplica ni la anticipa.
- **Proceso separado.** Este proyecto NO toca el monolito `nortex.20`: lo llama por
  HTTP con un service token. Nada de este repo vive dentro del monolito.
- **"Hoy" = día comercial America/Managua** (UTC-6, sin DST), no UTC.

## Requisitos

Node 20+.

## Cómo correrlo

```bash
npm install
npm run dev        # stdio, modo mock (default)
```

Modo contra backend real (F3, hoy bloqueado por falta de JWT de staging):

```bash
cp .env.example .env   # completar NORTEX_API_URL y NORTEX_SERVICE_TOKEN
NORTEX_API_MODE=http npm run dev
```

El token **solo** se lee de `NORTEX_SERVICE_TOKEN` en el entorno. Nunca va en el
repo, nunca se loguea (ver `test/auth.test.ts` y el grep de secretos abajo).

Variables opcionales:

| Variable | Default | Qué hace |
|---|---|---|
| `NORTEX_TENANT_ID` | `default` | Etiqueta del tenant/sesión para rate limit y auditoría (nunca sale del proceso) |
| `NORTEX_RATE_LIMIT_PER_MIN` | `30` | Máx. tool calls por minuto por tenant (ops/stdio) o por tenant+usuario (modo cliente) |

## Tools

| Tool | Input | Respuesta (ejemplo) |
|---|---|---|
| `ventas_hoy` | — | "Hoy vendiste C$12,450.00 en 38 facturas. Tu mejor producto fue Queso frito." |
| `buscar_producto` | `q` (mín 2), `limit` (default 10, máx 50) | "Queso frito: C$120.00 la libra, te quedan 15 en Principal y 4 en Sucursal." |
| `stock_producto` | `producto` (mín 2) | "Del Queso frito te quedan 19 libras en total: 15 en Principal, 4 en Sucursal." |
| `ventas_periodo` | `dias` (1–30, default 7) | "En los últimos 7 días vendiste C$82,749.00 en 261 facturas. El mejor día fue el viernes con C$14,014.00." |
| `inventario_bajo` | `umbral?` (entero positivo; default: punto de reorden), `limit` (default 10, máx 50) | "Tenés 2 productos bajos: Queso fresco (8, mínimo 12) y Leche (6, mínimo 12)." |
| `estado_conteo` | `bodega?` (nombre; default: todas) | "Tenés 2 conteos abiertos: Principal (120 de 200 contados) y Sucursal (30 de 50 contados)." |
| `precio_producto` | `producto` (mín 2) | "El Queso frito vale C$120.00 la libra." |
| `detalle_venta` | `factura` (número DGI) | "Ese detalle no lo tengo en texto." (fail closed, ver abajo) |
| `resolver_duda` | `pregunta` (5–500 letras) | "Sí. Creás el producto UNA vez… tocás el botón «+1 CAJA (12)»…" + `Fuente:` + `Confianza:` (ver abajo) |
| `informe_ventas` | `periodo?` (`hoy`/`ayer`/`semana`/`mes`, default `mes`), `desde?`+`hasta?` (YYYY-MM-DD, máx 31 días), `top?` (1–5, default 3) | "En los últimos 30 días vendiste C$82,749 en 261 facturas, con utilidad bruta de C$24,317. Tu producto más vendido fue el Queso frito." + bloque de detalle (ver abajo) |

Reglas de voz: voseo, corto, sin IDs internos, sin JSON crudo. Vacío es normal
("No hubo ventas hoy todavía.", "No encontré nada como 'queso azul'.",
"No tenés productos bajos de stock.", "No tenés conteos abiertos.").
401/403 → "No pude acceder a tu negocio, revisá tu sesión." (fail closed, cero datos).
`ventas_hoy`/`ventas_periodo` **ordenan** `products[]`/`daily[]` del reporte
(el backend ya agrega); el servidor nunca recalcula dinero desde transacciones.
`fmtMoney` vive en un solo lugar (`src/fmtMoney.ts`) — F2 lo reutiliza, no lo duplica.

### `informe_ventas` — el Reporte integral a pedido (F5)

Es la victoria rápida #2 del Plan Nivel Odoo (ítem 7): lo que la clienta pide
por WhatsApp — «¿hay algún reporte de ventas? ¿un consolidado? ¿lo que más se
vende?» — sin navegar la pantalla.

- **Composición (sin duplicar lógica de dinero):** una sola llamada a
  `GET /api/reports/sales?startDate&endDate`, el mismo endpoint que alimenta
  la pantalla de Reportes y el Excel de 5 hojas. La respuesta ya trae
  `summary` (brutas, devoluciones, netas, IVA, utilidad bruta, ticket
  promedio), `paymentMethods[]` y `products[]` (cantidad neta, venta neta y
  utilidad por producto), calculados por el backend. La tool **solo ordena y
  formatea**: jamás suma ni resta dinero. No hizo falta ningún endpoint nuevo
  en `nortex.20`.
- **Rankings ordenados de verdad:** la tabla «Productos vendidos» de la UI
  sale en orden alfabético; acá «Lo que más se vendió» ordena por cantidad
  neta y «Lo que más utilidad dejó» por utilidad bruta, de mayor a menor.
- **Salida en dos bloques:** resumen hablado de ≤ ~25 palabras (contrato de
  voz T6 §4.1, dinero con `fmtVoiceMoney`, sin centavos) + bloque «Detalle
  del informe» en texto para pantalla/WhatsApp con el consolidado completo.
- **Rango máximo 31 días** en rangos personalizados: paridad con el
  documento/Excel del backend (`SALES_EXPORT_MAX_DAYS = 31`). Los períodos
  rápidos son `hoy`, `ayer`, `semana` (últimos 7 días) y `mes` (últimos 30).
- **Fail closed:** el tenant sale solo de la sesión (la tool nunca envía
  `tenantId`); 401/403 → el mensaje de siempre, cero datos. Período sin
  ventas → "No hubo ventas en ese período.".

### `resolver_duda` — NortexGPT: dudas de uso (F6)

Responde «¿cómo se hace X en Nortex?» **solo con fuentes oficiales**, sin APIs
pagas ni embeddings externos:

- `knowledge/manual.json` — el Manual de Usuario PDF segmentado por capítulo y
  subsección, con figuras y página. Se regenera con
  `node scripts/build-manual-kb.mjs [ruta.pdf]` (requiere `pdftotext`); el JSON
  va versionado, así que el servidor no necesita el PDF en runtime. Un test
  compara su sha256 contra el PDF oficial cuando el PDF está en la máquina.
- `knowledge/casos.json` — casos reales **verificados contra el código** de
  `nortex.20` (empaque caja/unidad, código de barras único, regalías por ajuste,
  lotes vigentes/FEFO, anulación en negocio unipersonal). Editable: cada caso
  cita los archivos donde se verificó y la fecha. Nunca agregar un caso sin
  verificarlo.

Recuperación: BM25 propio (`src/knowledge.ts`) con normalización de tildes,
stopwords y stemming liviano en español. La respuesta es **extractiva** (texto
literal del caso o del segmento del manual), con `Fuente:` (caso, o capítulo ›
sección (Figura N), página), `Ver también:` y `Confianza: alta|media`. Si la
fuente elegida no cubre al menos el 60 % de los términos de la pregunta →
`"Sin fundamento en el manual: …"`, sin pasos. No recibe la API ni toca datos
del tenant; si la base no carga, fail closed con mensaje en voseo.

### `detalle_venta` — exclusión documentada (fail closed)

**Evidencia:** `CONTRATOS-F0-BORRADOR.md` §E5c (hallazgo T4-02): la ruta candidata
`GET /api/reports/sales/document` (`backend/routes/salesReports.ts:249`) responde
**`text/html`** (`renderSalesReportHtml`), no JSON. El JSON de
`GET /api/reports/sales/transactions` (E5b) es la fuente canónica, pero expone
IDs internos y paginación que el diseño v1 no resuelve todavía.

**Decisión:** no se parsea HTML en el MCP. El handler devuelve el string fijo
`"Ese detalle no lo tengo en texto."` sin tocar la red (ni siquiera valida el
argumento; los tests lo prueban contra un backend caído y en modo unauthorized).
Cuando el backend exponga el detalle como JSON (F3+), la tool se re-diseña con
su propio ticket.

### Rate limit

- **30 tool calls por minuto por clave** (ventana deslizante de 60 s). Clave:
  el tenant en stdio/ops; `tenant:usuario` (claims del JWT) en modo cliente —
  cada persona su cubeta, y reconectar no la resetea; `opaque:<sha256 del token>`
  con acceso para IA `nxt_` (F7.1) — cada acceso su cubeta, aunque sean del mismo dueño.
  configurable con `NORTEX_RATE_LIMIT_PER_MIN`. El default es holgado para voz
  (una consulta ≈ 1–3 calls) y frena bucles accidentales del modelo antes de
  golpear el backend.
- Al excederlo, la tool responde en voseo (string congelado en tests):
  `"Estás yendo muy rápido. Esperá un momento y probá de nuevo."`
- Se aplica **antes** de llamar al backend, en las 9 tools.

### Auditoría

Cada tool call escribe **una línea JSON por stderr** (stdout es solo protocolo MCP):

```json
{"event":"tool_call","tool":"ventas_hoy","tenant":"default","mode":"ops","ts":"2026-10-09T03:44:28.277Z","latencyMs":4,"status":"ok"}
{"event":"tool_call","tool":"ventas_hoy","tenant":"t-pulperia","userId":"u-ana","role":"OWNER","mode":"client","authKind":"jwt","ts":"…","latencyMs":14,"status":"ok"}
{"event":"tool_call","tool":"ventas_hoy","tenant":null,"mode":"client","authKind":"opaque","subject":"opaque:3f9c…(sha256 hex)","ts":"…","latencyMs":12,"status":"ok"}
```

Campos: `tool`, `tenant` (`null` en sesiones opacas: el MCP no lo conoce), `userId`
y `role` (solo modo cliente con JWT), `mode` (`ops` | `client`), `authKind`
(`jwt` | `opaque`, solo modo cliente), `subject` (solo opaco: SHA-256 hex del
token, el mismo hash que guarda el monolito), `ts` (ISO), `latencyMs`, `status`
(`ok` | `error` | `rate_limited`). **Nunca** se registra el token ops, el JWT del
cliente (ni su firma, ni el email del payload: solo ids) ni el token opaco (ni
fragmentos: solo su hash), los argumentos del call (pueden llevar datos del
negocio) ni respuestas del backend.

## Tests

```bash
npm test   # vitest: 161 tests (F7: 21 de auth por cliente y aislamiento entre tenants) (happy/empty/error por tool, strings exactos en
           # voseo, validación zod, aislamiento cross-tenant, rate limit,
           # fail closed de detalle_venta, fmtMoney, envelope HTTP real)
```

Sin secretos en el repo (verificado):

```bash
grep -rniE "token|secret|bearer|password|api[_-]?key" src/ test/ .env.example
# -> solo plomería: lectura de process.env.NORTEX_SERVICE_TOKEN,
#    construcción del header Authorization, y fixtures falsos en tests.
```

Cero writes (verificado): el único `fetch` del repo es el cliente GET de
`src/nortexApi.ts`; no hay POST/PUT/PATCH/DELETE ni SQL de escritura.

Typecheck (lo corre el coordinador en serie con los del monolito — no correr en paralelo):

```bash
npm run typecheck
```

## Gate F2: inspector

Verificado con el MCP Inspector en modo CLI (2026-10-08, `@modelcontextprotocol/inspector`):

- `tools/list` → las 8 tools listadas, `inputSchema` JSON Schema válido para cada una.
- `tools/call` → las 5 nuevas responden con los strings exactos en voseo:
  - `ventas_periodo {"dias":7}` → "En los últimos 7 días vendiste C$82,749.00 en 261 facturas. El mejor día fue el viernes con C$14,014.00."
  - `inventario_bajo {}` → "Tenés 2 productos bajos: Queso fresco (8, mínimo 12) y Leche (6, mínimo 12)."
  - `estado_conteo {}` → "Tenés 2 conteos abiertos: Principal (120 de 200 contados) y Sucursal (30 de 50 contados)."
  - `precio_producto {"producto":"queso frito"}` → "El Queso frito vale C$120.00 la libra."
  - `detalle_venta {"factura":"A-001234"}` → "Ese detalle no lo tengo en texto."

(Nota: el CLI del inspector exige el target como primer posicional y las opciones
después de `--`; los args de tools/call van como pares `--tool-arg k=v`:
`inspector --cli node dist/index.js -- --method tools/call --transport stdio --tool-name precio_producto --tool-arg 'producto=queso frito'`.)

## Mapa de endpoints reales (verificado contra el código del monolito, 2026-10-14)

| Tool | Endpoint(s) real(es) que consume | Fuente en nortex.20 |
|---|---|---|
| `ventas_hoy` | `GET /api/reports/sales` (día = America/Managua, del `daily[]` ya agregado) | `backend/routes/salesReports.ts` (`GET /sales`) + `backend/lib/salesReport.ts` (`netSales` string, `transactionCount` número) |
| `ventas_periodo` | `GET /api/reports/sales?startDate&endDate` | idem |
| `buscar_producto` | `GET /api/products?search&page&pageSize` + `GET /api/warehouses/product/:id/stock` por resultado | `backend/routes/productCatalog.ts` (`GET /`, paginado `{products,total,page,pageSize}`) + `backend/routes/warehouses.ts:27` |
| `stock_producto` | `GET /api/products?search&page&pageSize` + `GET /api/warehouses/product/:id/stock` | idem |
| `precio_producto` | `GET /api/products?search&page&pageSize` | `backend/routes/productCatalog.ts` |
| `inventario_bajo` | `GET /api/products?lowStock=true&page&pageSize` | `backend/routes/productCatalog.ts` (filtra `stock <= minStock`) |
| `estado_conteo` | `GET /api/stock-counts` (lista) + `GET /api/stock-counts/:id` (avance) | `backend/server.ts` (lista: `_count.items` = total; detalle: `{count, items[]}`, `StockCountItem.counted` nullable en `schema.prisma`) |
| `detalle_venta` | — (fail closed, no consume red) | `GET /api/reports/sales/document` responde HTML (`backend/routes/salesReports.ts:244`); el JSON `GET /api/reports/sales/transactions` expone IDs internos |
| `informe_ventas` | `GET /api/reports/sales?startDate&endDate` (la forma COMPLETA: `summary`, `paymentMethods[]`, `products[]` con `quantityNet`/`grossProfit`) | `backend/lib/salesReport.ts` (`SalesReportData`/`SalesReportSummary`/`SalesReportPaymentMethod`/`SalesReportProduct`, verificado 2026-10-15) + `backend/routes/salesReports.ts` (`GET /sales`) |

Dos correcciones que salieron de esta verificación (aplicadas el 2026-10-14):

1. **Envelope `{success, data}`:** el stock por bodega envuelve la respuesta;
   `createHttpNortexApi` ahora la desenvuelve (`unwrapEnvelope`, con tests).
   Sin esto, `buscar_producto`/`stock_producto` habrían fallado contra el
   backend real en F3.
2. **Avance de conteo:** la lista de conteos NO trae `countedItems/totalItems`
   (eso era el borrador F0); trae solo `_count.items`. `estado_conteo` ahora
   calcula el avance desde el detalle (`items` con `counted != null`).

## Gate 2026-10-14 (protocolo, además de los tests unitarios)

- `npm test` → **73/73** (6 archivos; +4 nuevos de `test/nortexApi.test.ts`).
- `npm run typecheck` → exit 0. `npm run build` → OK.
- **Smoke de protocolo MCP** (`scripts/protocol-smoke.mjs`, cliente real del
  SDK sobre stdio contra `dist/index.js`): handshake OK
  (`nortex-mcp v0.2.0`), `tools/list` = 8 tools con schemas, 9 llamadas
  (las 8 tools + `estado_conteo` filtrado) respondidas en voseo, auditoría
  por stderr (9 líneas `status:"ok"`). Transcripción completa en
  `scripts/protocol-smoke-output.txt`.

## Gate F5 2026-10-15 (informe_ventas, v0.3.0)

- `npm test` → **105/105** (8 archivos; +20: `test/informe.test.ts` con 17
  casos — happy con string exacto, rankings con órdenes distintos por
  cantidad vs. utilidad, rango de 31 días pasa / 32 rechazado sin tocar la
  red, fail closed sin fuga de datos, aislamiento (la tool solo envía
  `startDate`/`endDate`) — y 3 de `fmtVoiceMoney`).
- `npm run typecheck` → exit 0. `npm run build` → OK.
- **Smokes de protocolo re-corridos:** stdio (`scripts/protocol-smoke.mjs`,
  ahora con 4 llamadas a `informe_ventas`: mes, semana, rango válido y rango
  >31 días rechazado) y HTTP (`scripts/protocol-smoke-http.mjs`:
  `tools/list` = 9 tools, llamada a `informe_ventas` OK, 401 sin token).
  Transcripciones en `scripts/protocol-smoke-output.txt` y
  `scripts/protocol-smoke-http-output.txt`.
- **Cómo se prueba en staging (cuando F3 se desbloquee con el JWT):** con
  `NORTEX_API_MODE=http` apuntando a staging, `informe_ventas {periodo:"mes"}`
  debe coincidir cifra por cifra con la pantalla de Reportes del mismo
  tenant y período (brutas/netas/IVA/utilidad/ticket), y el ranking «Lo que
  más se vendió» debe ser el mismo conjunto de la tabla «Productos vendidos»
  pero ordenado por cantidad neta descendente. Esa comparación ES el contract
  test de F3 para esta tool; hoy queda bloqueada por el mismo paso de cuenta
  que el resto de F3.

## Estructura

```
src/
  index.ts      # entrada: elige transporte (stdio default, MCP_TRANSPORT=http)
  server.ts     # createNortexMcpServer(deps): las 10 tools + guarded (rate limit + auditoría), compartido por ambos transportes
  http.ts       # F4: Streamable HTTP stateless en /mcp + auth bearer interina
  tools.ts      # handlers (inyectan NortexApi): validación zod estricta + voseo
  knowledge.ts  # F6: corpus (manual + casos), tokenizador ES, BM25, decisión fail closed
  resolverDuda.ts # F6: handler de resolver_duda (solo conocimiento)
  nortexApi.ts  # interfaz inyectable + createHttpNortexApi + NortexAuthError
  mock.ts       # mock F1+F2 basado en el borrador F0 (datos sintéticos)
  types.ts      # formas mínimas del contrato (E1, E4, E5a, stock-counts)
  fmtMoney.ts   # ÚNICO formateo de dinero/cantidades ("C$12,450.00")
  time.ts       # todayManagua(): día comercial America/Managua (+ helpers de período)
  rateLimit.ts  # RateLimiter por tenant/sesión (default 30/min)
  audit.ts      # auditLog: línea JSON por stderr (tool, tenant, ts, latencia, status)
test/
  tools.test.ts     # F1: happy/empty/error + strings exactos + validación zod
  toolsF2.test.ts   # F2: happy/empty/error por tool nueva + cross-tenant + fail closed
  rateLimit.test.ts # límite, ventana de 60s, aislamiento por tenant, env
  http.test.ts      # F4: handshake/listTools/llamada por HTTP, 401, config fail closed
  auth.test.ts      # cross-tenant fail closed + token solo vía env
  fmtMoney.test.ts  # formateo centralizado (+ fmtVoiceMoney)
  resolverDuda.test.ts # F6: banco de pruebas (5 preguntas reales) + sin fundamento + integridad de la base
  informe.test.ts   # F5: informe_ventas happy/vacío/error, rankings ordenados, rango ≤31 días, aislamiento
knowledge/
  manual.json   # F6: Manual PDF segmentado (generado por scripts/build-manual-kb.mjs)
  casos.json    # F6: casos verificados contra el código (editable)
```

## Conexión con MuseNortex (regla de oro)

Este servidor **es el transporte de las tools de voz de T6** (MUSE-01): las 8 tools
nuevas del hackatón se montan como capabilities de este mismo MCP, no como un
servicio aparte. Heredan toda la governance: tenant fijado por la sesión
(`NORTEX_TENANT_ID`, nunca seteable por un tool call), fail closed en 401/403,
agregados server-side (el modelo narra, nunca calcula dinero), voseo, rate limit
y auditoría. F2 completa el set de lectura que el demo del hackatón Meta necesita.
`precio_dolares` (T6-10) extiende `precio_producto` a USD — vive en T6, no acá.

## F4 — transporte Streamable HTTP

Además de stdio, el servidor habla Streamable HTTP (spec MCP) con las MISMAS 9 tools y la
misma governance (`createNortexMcpServer`).

```
npm run build
NORTEX_MCP_HTTP_TOKEN=<secreto> npm run start:http      # o: MCP_TRANSPORT=http node dist/index.js
```

| Variable | Default | Uso |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `http` activa Streamable HTTP |
| `MCP_HTTP_PORT` | `8931` | puerto |
| `MCP_HTTP_HOST` | `127.0.0.1` | loopback; no se abre a 0.0.0.0 salvo que lo pidas |
| `NORTEX_MCP_HTTP_TOKEN` | — | token bearer de **operador** (modo ops). Obligatorio salvo que esté activo el modo cliente |
| `NORTEX_TENANT_ID` | `default` | tenant del modo ops; ningún header/parámetro lo cambia |
| `NORTEX_MCP_CLIENT_AUTH` | apagado | `1`/`true`/`on` activa el **modo cliente** (F7, ver abajo) |
| `NORTEX_API_URL` | — | en modo cliente: URL del monolito que valida el JWT y sirve los datos |

Sin `NORTEX_MCP_HTTP_TOKEN` ni modo cliente, el proceso no arranca (fail closed).

- Modo ops: endpoint `POST /mcp`, **stateless** (`sessionIdGenerator: undefined`): tools read-only e
  idempotentes, sin estado por sesión. El SDK exige un servidor+transport por request en este modo;
  rate limiter y api se comparten, así que el límite por tenant sigue siendo global. GET/DELETE → 405.
- Auth interina: `Authorization: Bearer <token>`, comparación en tiempo constante
  (`timingSafeEqual` sobre SHA-256). Ausente o incorrecto → 401 sin cuerpo de protocolo.
- Smoke: `node scripts/protocol-smoke-http.mjs` → `scripts/protocol-smoke-http-output.txt`.

**Qué NO es:** no es OAuth ni conector publicable (F5, requiere OK de Noel); no es paridad
contra staging (F3, bloqueada por falta de JWT). Modo ops: un solo token compartido; sin TLS propio:
para exponerlo fuera de loopback hace falta un proxy TLS delante.

## F7 — modo cliente: cada negocio con SU cuenta

Dos modos de auth en el mismo endpoint `/mcp`, que pueden coexistir.
**Precedencia por request:** (1) si el bearer es `NORTEX_MCP_HTTP_TOKEN` → **ops**
(F4, stateless, tenant y api del entorno, sin cambios); (2) si no, y
`NORTEX_MCP_CLIENT_AUTH` está activo → **cliente**; (3) si no → 401.

```
NORTEX_MCP_CLIENT_AUTH=1 NORTEX_API_URL=https://<api de nortex> \
  [NORTEX_MCP_HTTP_TOKEN=<secreto ops>] MCP_TRANSPORT=http node dist/index.js
```

Mecánica del modo cliente (`src/http.ts`):

1. El cliente manda `Authorization: Bearer <JWT de Nortex>` — el mismo JWT de
   sesión con el que la app autentica (HS256, `{userId, tenantId, role}`, 30 días).
   **El MCP no tiene el secreto JWT ni verifica la firma**: eso lo hace el monolito.
2. Sin `Mcp-Session-Id` solo se acepta `initialize`. Antes de tocar la red se
   decodifican los claims y se rechaza (401) si faltan `userId`/`tenantId`/`role`,
   si trae `kind` (tokens de repartidor o de tracking de pedido: nunca son sesión
   de usuario) o si `exp` ya pasó.
3. **Una sonda** con ese JWT: `GET /api/products?page=1&pageSize=1` (la lectura más
   liviana que ya usa el MCP; exenta del paywall en el monolito). El monolito
   verifica firma + usuario activo contra BD. 401/403 → **401 sin cuerpo**;
   cualquier otro fallo (caído, 5xx, red) → **503**. En ambos casos no se crea sesión.
4. Se abre una sesión MCP con estado (`Mcp-Session-Id`) con `tenantId`, `userId`,
   `role` fijados y un `NortexApi` **por sesión** construido con el JWT del cliente.
   Cada tool call vuelve a pasar por el monolito, que re-valida el JWT y acota al
   tenant del token (si el usuario se deshabilita a mitad de sesión, la tool
   responde «revisá tu sesión», sin datos).
5. La sesión está atada al SHA-256 del JWT que la abrió: el mismo `Mcp-Session-Id`
   con otro bearer → 401. Sesión inactiva 30 min o JWT vencido → se cierra.
   `DELETE /mcp` con la sesión la cierra. Tope de 1000 sesiones vivas (503 al llenarse).
6. **Ninguna tool acepta tenant** (test que recorre los `inputSchema` de las 10);
   un `tenantId` inyectado en los argumentos se descarta.

#### F7.1 — acceso para IA (`nxt_`)

El monolito emite (Nortex → Configuración → «Acceso para IA», solo OWNER/ADMIN)
un token **opaco** `nxt_` + 32 bytes base64url: solo lectura (403 en todo no-GET),
revocable, y en su BD vive solo el SHA-256. Si el bearer empieza con `nxt_`:

1. **No se decodifica nada** (no es JWT, no hay claims ni `exp`). La validación
   es la MISMA sonda `GET /api/products?page=1&pageSize=1`: 200 → sesión;
   401/403 → **401 sin cuerpo**; 5xx/red → **503**. Nunca hay sesión sin sonda OK.
2. La sesión queda atada al SHA-256 del token (comparación en tiempo constante,
   igual que JWT): otro bearer — otro acceso del mismo dueño, su JWT, otro
   negocio — con ese `Mcp-Session-Id` → 401.
3. `tenantId`/`userId`/`role` quedan **`null`** en la sesión: el monolito resuelve
   el negocio por el token en cada llamada (y revalida que el emisor siga activo
   y no revocado). Ninguna tool recibe tenant del MCP (invariante de F7 intacto).
4. Rate limit y auditoría por `opaque:<sha256 hex>`; la auditoría marca
   `authKind: "opaque"`. El token en claro no aparece en ningún log.
5. Vencimiento: el de la sesión MCP (30 min sin uso / `DELETE`); el MCP no
   inventa un `exp`. Si el dueño revoca el acceso, la próxima tool call ya
   responde «revisá tu sesión», sin datos.

El camino JWT y el modo ops no cambiaron (salvo el campo `authKind: "jwt"`
agregado a la auditoría de las sesiones JWT).

### Para clientes: conectá tu IA

1. **Entrá a Nortex** con tu cuenta de dueño o administrador y andá a
   **Configuración → «Acceso para IA»**.
2. **Creá un acceso** y ponele un nombre que te ayude a reconocerlo (por ejemplo,
   «Mi Claude» o «ChatGPT de la tienda»).
3. Nortex te muestra un **bloque de conexión** («copia y pega esto a tu IA»).
   Tocá **«Copiar bloque»** y copialo **completo**, tal como está: ya trae todo
   lo que tu IA necesita para conectarse.
4. **Pegáselo a tu IA** y seguí lo que te diga para terminar de conectarse.
5. Listo: preguntale cosas como «¿cuánto vendí hoy?», «¿qué productos me están
   quedando bajos?» o «¿cómo vendo por caja y por unidad?».

Bueno saber:

- **Solo puede ver, nunca cambiar nada.** Tu IA consulta tus ventas, tu
  inventario y resuelve tus dudas de Nortex, pero no puede vender, anular ni
  modificar nada.
- **Ve solo tu negocio.**
- **Guardalo bien.** Nortex muestra el bloque una sola vez. Si lo perdés, no pasa
  nada: borralo y creá otro.
- **Lo apagás cuando querés.** Desde la misma pantalla podés revocar un acceso y
  esa IA deja de ver tu negocio al instante. Si tu cuenta se desactiva, el
  acceso también deja de funcionar.
- Si tu IA te dice que no pudo entrar a tu negocio, revisá que el acceso siga
  activo en «Acceso para IA», o creá uno nuevo y volvé a pegar el bloque.

> Nota de operación (no es para clientes): el bloque trae la dirección del
> servidor MCP (`VITE_MCP_URL`, default `https://mcp.somosnortex.com/mcp`) y el
> acceso `nxt_`. Para que funcione, este MCP tiene que estar desplegado ahí con
> `NORTEX_MCP_CLIENT_AUTH=1` detrás de un proxy TLS (hoy escucha en loopback).
> El JWT de sesión de la app sigue aceptado (F7) para pruebas internas.

Smoke F7 + F7.1 (ops, JWT y acceso opaco + monolito falso en proceso): `node scripts/protocol-smoke-http.mjs`.

## Siguiente

F3: paridad contra staging con JWT real (incluye el contract test de
`informe_ventas` contra la pantalla de Reportes y re-diseñar `detalle_venta`
si el backend expone JSON). OAuth / conector publicable (la otra mitad de la
«F5» original de fases; requiere OK de Noel) sigue pendiente: esta entrega
solo agregó la tool, no tocó la auth interina de F4.
