import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockNortexApi } from "../src/mock.js";
import { RateLimiter } from "../src/rateLimit.js";
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  bearerMatches,
  createHttpApp,
  httpConfigFromEnv,
  listen,
} from "../src/http.js";

const TOKEN = "token-de-prueba-f4";
const TOOLS = [
  "buscar_producto",
  "detalle_venta",
  "estado_conteo",
  "informe_ventas",
  "inventario_bajo",
  "precio_producto",
  "resolver_duda",
  "stock_producto",
  "ventas_hoy",
  "ventas_periodo",
];

let app: Server;
let url: URL;

beforeAll(async () => {
  app = createHttpApp({
    ops: { token: TOKEN, api: createMockNortexApi(), tenant: "tenant-test" },
    rateLimiter: new RateLimiter(1000),
  });
  const addr = await listen(app, 0, "127.0.0.1");
  url = new URL(`http://127.0.0.1:${addr.port}/mcp`);
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

async function connect(token: string) {
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("Streamable HTTP", () => {
  it("handshake + listTools = las 10 tools", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    await client.close();
  });

  it("ventas_hoy responde en voseo", async () => {
    const client = await connect(TOKEN);
    const r = await client.callTool({ name: "ventas_hoy", arguments: {} });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join(" ");
    expect(text).toMatch(/vendiste|vendieron|C\$/i);
    await client.close();
  });

  it("resolver_duda responde por protocolo con fuente y confianza", async () => {
    const client = await connect(TOKEN);
    const r = await client.callTool({
      name: "resolver_duda",
      arguments: { pregunta: "¿Puedo vender el mismo producto por caja y por unidad?" },
    });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join(" ");
    expect(text).toContain("+1 CAJA");
    expect(text).toMatch(/Fuente: Caso verificado/);
    expect(text).toMatch(/Confianza: alta/);
    await client.close();
  });

  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
  });
  const post = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: init,
    });

  it("sin Authorization → 401 sin cuerpo de protocolo", async () => {
    const r = await post({});
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
  });

  it("token equivocado → 401", async () => {
    const r = await post({ Authorization: "Bearer otro-token" });
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
  });

  it("esquema distinto de Bearer → 401", async () => {
    expect((await post({ Authorization: TOKEN })).status).toBe(401);
  });

  it("token correcto → 200", async () => {
    expect((await post({ Authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it("GET autenticado → 405 (stateless); ruta distinta → 404", async () => {
    const g = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(g.status).toBe(405);
    const o = await fetch(new URL("/otra", url), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(o.status).toBe(404);
  });

  it("un header X-Tenant-Id no cambia el tenant (no se lee)", async () => {
    const r = await post({ Authorization: `Bearer ${TOKEN}`, "X-Tenant-Id": "otro" });
    expect(r.status).toBe(200);
  });
});

describe("config HTTP", () => {
  it("sin NORTEX_MCP_HTTP_TOKEN ni modo cliente lanza (fail closed)", () => {
    expect(() => httpConfigFromEnv({})).toThrow(/NORTEX_MCP_HTTP_TOKEN/);
    expect(() => httpConfigFromEnv({ NORTEX_MCP_HTTP_TOKEN: "" })).toThrow(/NORTEX_MCP_HTTP_TOKEN/);
  });
  it("defaults: loopback y 8931", () => {
    expect(httpConfigFromEnv({ NORTEX_MCP_HTTP_TOKEN: "x" })).toEqual({
      token: "x",
      port: DEFAULT_HTTP_PORT,
      host: DEFAULT_HTTP_HOST,
    });
    expect(DEFAULT_HTTP_HOST).toBe("127.0.0.1");
    expect(DEFAULT_HTTP_PORT).toBe(8931);
  });
  it("respeta MCP_HTTP_PORT / MCP_HTTP_HOST y rechaza puerto inválido", () => {
    const c = httpConfigFromEnv({ NORTEX_MCP_HTTP_TOKEN: "x", MCP_HTTP_PORT: "9000", MCP_HTTP_HOST: "10.0.0.1" });
    expect(c.port).toBe(9000);
    expect(c.host).toBe("10.0.0.1");
    expect(() => httpConfigFromEnv({ NORTEX_MCP_HTTP_TOKEN: "x", MCP_HTTP_PORT: "abc" })).toThrow(/inválido/);
  });
  it("bearerMatches", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches("Bearer ", TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
  });
});
