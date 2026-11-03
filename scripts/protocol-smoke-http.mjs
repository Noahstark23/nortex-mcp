/**
 * Smoke de protocolo MCP sobre Streamable HTTP (F4 + F7): levanta `node dist/index.js`
 * con MCP_TRANSPORT=http en un puerto efímero con AMBOS modos de auth:
 *  - ops (F4): token de operador, api mock del entorno;
 *  - cliente (F7): JWT de Nortex del cliente, validado por un monolito FALSO
 *    en proceso (HS256 con secreto que el MCP no conoce, datos por tenant);
 *  - cliente con token opaco (F7.1): «acceso para IA» `nxt_…`; el monolito
 *    falso lo busca por SHA-256 y acota al tenant de esa fila.
 * Conecta el cliente oficial, lista tools, las llama y comprueba los 401.
 * Transcripción en protocol-smoke-http-output.txt.
 * Uso: npm run build && node scripts/protocol-smoke-http.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createMockNortexApi } from "../dist/mock.js";

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

const port = await new Promise((res) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const TOKEN = "smoke-token-" + Math.random().toString(36).slice(2);
// ---- Monolito falso (F7): verifica el JWT en CADA request y acota al tenant del token ----
const SECRET = "smoke-secret-" + Math.random().toString(36).slice(2);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload, secret = SECRET, ttl = 3600) => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iat: now, exp: now + ttl, ...payload })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
};
const tenants = {
  "t-pulperia": createMockNortexApi(),
  "t-ferreteria": {
    async get(path, q) {
      if (path === "/api/products") {
        const all = [{ id: "b-tornillo", name: "Tornillo de 3/8", price: 7.5, unit: "unidad" }];
        const m = all.filter((p) => p.name.toLowerCase().includes(String(q.search ?? "").toLowerCase()));
        return { products: m, total: m.length, page: 1, pageSize: 10 };
      }
      if (path === "/api/warehouses/product/b-tornillo/stock")
        return { productId: "b-tornillo", totalStock: "900.0000", unit: "unidad", hasMore: false,
          warehouses: [{ id: "b-w1", name: "Bodega Ferretera", isDefault: true, isActive: true, stock: "900.0000", implicit: false }] };
      if (path === "/api/reports/sales") return { products: [], daily: [] };
      return [];
    },
  },
};
const monoCalls = [];
// F7.1: tabla de tokens opacos del monolito (solo hashes) → tenant de la fila.
const sha = (s) => createHash("sha256").update(s).digest("hex");
const NXT_A = "nxt_" + randomBytes(32).toString("base64url");
const NXT_REVOCADO = "nxt_" + randomBytes(32).toString("base64url");
const opaqueRows = new Map([[sha(NXT_A), { tenantId: "t-pulperia", revoked: false }], [sha(NXT_REVOCADO), { tenantId: "t-pulperia", revoked: true }]]);
const mono = createHttpServer(async (req, res) => {
  const send = (st, b) => res.writeHead(st, { "Content-Type": "application/json" }).end(JSON.stringify(b));
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (bearer.startsWith("nxt_")) {
    const row = opaqueRows.get(sha(bearer));
    if (!row || row.revoked) return send(401, { error: "El token de acceso para IA no es válido o fue revocado.", code: "MCP_TOKEN_INVALID" });
    const u = new URL(req.url, "http://x");
    monoCalls.push(`[opaco] ${row.tenantId} ${u.pathname}${u.search}`);
    return send(200, await tenants[row.tenantId].get(u.pathname, Object.fromEntries(u.searchParams)));
  }
  const [h, p, sig] = (req.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
  const exp = h && p ? createHmac("sha256", SECRET).update(`${h}.${p}`).digest() : Buffer.alloc(0);
  const got = Buffer.from(sig ?? "", "base64url");
  if (!sig || got.length !== exp.length || !timingSafeEqual(got, exp)) return send(403, { error: "Token inválido o expirado." });
  const c = JSON.parse(Buffer.from(p, "base64url").toString());
  const u = new URL(req.url, "http://x");
  monoCalls.push(`${c.tenantId} ${u.pathname}${u.search}`);
  send(200, await tenants[c.tenantId].get(u.pathname, Object.fromEntries(u.searchParams)));
});
const monoPort = await new Promise((r) => mono.listen(0, "127.0.0.1", () => r(mono.address().port)));
const JWT_A = sign({ userId: "u-ana", tenantId: "t-pulperia", role: "OWNER" });
const JWT_B = sign({ userId: "u-carla", tenantId: "t-ferreteria", role: "OWNER" });
const redact = (s) =>
  s.replaceAll(TOKEN, "<token-ops>").replaceAll(JWT_A, "<jwt-A>").replaceAll(JWT_B, "<jwt-B>").replaceAll(NXT_A, "<nxt-A>");

const child = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    MCP_TRANSPORT: "http",
    MCP_HTTP_PORT: String(port),
    NORTEX_MCP_HTTP_TOKEN: TOKEN,
    NORTEX_API_MODE: "mock",
    NORTEX_MCP_CLIENT_AUTH: "1",
    NORTEX_API_URL: `http://127.0.0.1:${monoPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const stderrLines = [];
let rawStderr = "";
let stdoutBytes = 0;
child.stdout.on("data", (d) => (stdoutBytes += d.length));
let ready;
const up = new Promise((r) => (ready = r));
child.stderr.on("data", (d) => {
  rawStderr += String(d);
  for (const l of String(d).split("\n")) {
    if (!l.trim()) continue;
    stderrLines.push(redact(l));
    if (l.includes("escuchando")) ready();
  }
});
await up;
const url = new URL(`http://127.0.0.1:${port}/mcp`);
log(`SERVIDOR HTTP arriba en http://127.0.0.1:${port}/mcp (modos ops + cliente; token ops efímero, mock; monolito falso en :${monoPort})`);

const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
log(`SIN TOKEN -> HTTP ${noAuth.status} (cuerpo: ${JSON.stringify(await noAuth.text())})`);
const bad = await fetch(url, { method: "POST", headers: { Authorization: "Bearer mal", "Content-Type": "application/json" }, body: "{}" });
log(`TOKEN MALO -> HTTP ${bad.status}`);

const client = new Client({ name: "nortex-mcp-smoke-http", version: "1.0.0" }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
log(`HANDSHAKE OK: server=${client.getServerVersion()?.name} v${client.getServerVersion()?.version}`);
const { tools } = await client.listTools();
log(`TOOLS/LIST: ${tools.length} tools`);
for (const t of tools) log(`  - ${t.name}`);

const calls = [
  ["ventas_hoy", {}],
  ["ventas_periodo", { dias: 7 }],
  ["buscar_producto", { q: "queso", limit: 10 }],
  ["stock_producto", { producto: "queso frito" }],
  ["inventario_bajo", {}],
  ["estado_conteo", {}],
  ["precio_producto", { producto: "queso frito" }],
  ["detalle_venta", { factura: "A-001234" }],
  ["informe_ventas", { periodo: "mes" }],
];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  log(`CALL ${name} ${JSON.stringify(args)}\n  -> ${r.content?.map((c) => c.text ?? "").join("\n")}`);
}
await client.close();

// ---- F7: modo cliente ----
log("== MODO CLIENTE (F7) ==");
const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } });
const rawInit = (tok) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: initBody });
const forged = await rawInit(sign({ userId: "u-ana", tenantId: "t-pulperia", role: "OWNER" }, "otro-secreto"));
log(`JWT FALSIFICADO -> HTTP ${forged.status} (cuerpo: ${JSON.stringify(await forged.text())})`);
const expired = await rawInit(sign({ userId: "u-ana", tenantId: "t-pulperia", role: "OWNER" }, SECRET, -60));
log(`JWT VENCIDO -> HTTP ${expired.status}`);
const driver = await rawInit(sign({ driverId: "d1", kind: "DRIVER" }));
log(`TOKEN DE REPARTIDOR (kind) -> HTTP ${driver.status}`);

const clientOf = async (jwt) => {
  const c = new Client({ name: "nortex-mcp-smoke-cliente", version: "1.0.0" }, { capabilities: {} });
  const t = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${jwt}` } } });
  await c.connect(t);
  return { c, t };
};
const before = monoCalls.length;
const a = await clientOf(JWT_A);
log(`CLIENTE A (t-pulperia) HANDSHAKE OK, sesión ${a.t.sessionId ? "con Mcp-Session-Id" : "SIN id"}; sonda: ${monoCalls.slice(before).join(" | ")}`);
const b = await clientOf(JWT_B);
log(`CLIENTE B (t-ferreteria) HANDSHAKE OK; tools: ${(await b.c.listTools()).tools.length}`);
const show = async (who, cl, name, args) => {
  const r = await cl.callTool({ name, arguments: args });
  log(`${who} CALL ${name} ${JSON.stringify(args)}\n  -> ${r.content?.map((x) => x.text ?? "").join("\n")}`);
};
await show("A", a.c, "buscar_producto", { q: "queso" });
await show("A", a.c, "buscar_producto", { q: "tornillo", tenantId: "t-ferreteria" });
await show("B", b.c, "buscar_producto", { q: "queso" });
await show("B", b.c, "buscar_producto", { q: "tornillo" });
await show("B", b.c, "resolver_duda", { pregunta: "¿Puedo vender el mismo producto por caja y por unidad?" });
const hijack = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${JWT_B}`, "Mcp-Session-Id": a.t.sessionId, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ventas_hoy", arguments: {} } }) });
log(`SECUESTRO (JWT de B + sesión de A) -> HTTP ${hijack.status} (cuerpo: ${JSON.stringify(await hijack.text())})`);
log(`MONOLITO recibió ${monoCalls.length - before} llamadas del modo cliente:`);
for (const l of monoCalls.slice(before)) log(`  ${l}`);

// ---- F7.1: token opaco nxt_ ----
log("== MODO CLIENTE CON TOKEN OPACO (F7.1) ==");
const expect = (label, got, want) => {
  log(`${label} -> HTTP ${got}${got === want ? "" : ` (ESPERADO ${want}: FALLA)`}`);
  if (got !== want) process.exitCode = 1;
};
const unknownNxt = await rawInit("nxt_" + randomBytes(32).toString("base64url"));
expect(`OPACO DESCONOCIDO (cuerpo: ${JSON.stringify(await unknownNxt.text())})`, unknownNxt.status, 401);
const revokedNxt = await rawInit(NXT_REVOCADO);
await revokedNxt.text();
expect("OPACO REVOCADO", revokedNxt.status, 401);
const beforeOpaque = monoCalls.length;
const o = await clientOf(NXT_A);
log(`CLIENTE OPACO (acceso de t-pulperia) HANDSHAKE OK, sesión ${o.t.sessionId ? "con Mcp-Session-Id" : "SIN id"}; sonda: ${monoCalls.slice(beforeOpaque).join(" | ")}`);
await show("OPACO", o.c, "buscar_producto", { q: "queso" });
await show("OPACO", o.c, "ventas_hoy", {});
await show("OPACO", o.c, "resolver_duda", { pregunta: "¿cómo anulo una venta?" });
const opaqueHijack = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${JWT_A}`, "Mcp-Session-Id": o.t.sessionId, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ventas_hoy", arguments: {} } }) });
await opaqueHijack.text();
expect("SESIÓN OPACA CON OTRO TOKEN (JWT de A)", opaqueHijack.status, 401);
log(`MONOLITO recibió ${monoCalls.length - beforeOpaque} llamadas de la sesión opaca:`);
for (const l of monoCalls.slice(beforeOpaque)) log(`  ${l}`);
await o.t.terminateSession();
await o.c.close();

await a.t.terminateSession();
await b.t.terminateSession();
await a.c.close();
await b.c.close();
child.kill();
mono.close();
log(`AUDIT (stderr, ${stderrLines.length} líneas):`);
for (const l of stderrLines) log(`  ${l}`);
// Sobre el stderr CRUDO del proceso (antes de redactar): ni el token ops ni los JWT ni sus firmas.
const secrets = [TOKEN, JWT_A, JWT_B, JWT_A.split(".")[2], JWT_B.split(".")[2], NXT_A, NXT_A.slice(4), NXT_REVOCADO.slice(4)];
const leaked = secrets.some((t) => rawStderr.includes(t));
log(`TOKENS EN EL STDERR CRUDO (logs + auditoría): ${leaked ? "SÍ (FALLA)" : "ninguno"}`);
if (leaked) process.exitCode = 1;
log(`stdout del proceso: ${stdoutBytes} bytes`);
writeFileSync(new URL("./protocol-smoke-http-output.txt", import.meta.url), lines.join("\n") + "\n");
log("SMOKE HTTP COMPLETO");
