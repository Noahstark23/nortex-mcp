/**
 * F7 — auth por cliente con su JWT de Nortex en el transporte HTTP.
 *
 * Cadena completa real: cliente MCP oficial → transporte HTTP del MCP →
 * createHttpNortexApi (fetch real) → monolito FALSO que firma/verifica JWT
 * HS256 con un secreto que el MCP no conoce y sirve datos por tenant.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockNortexApi } from "../src/mock.js";
import { createHttpNortexApi } from "../src/nortexApi.js";
import { RateLimiter } from "../src/rateLimit.js";
import { MSG_RATE_LIMIT, MSG_SIN_ACCESO } from "../src/tools.js";
import {
  PROBE_PATH,
  createHttpApp,
  decodeClientClaims,
  httpConfigFromEnv,
  listen,
  type HttpApp,
} from "../src/http.js";
import { createFerreteriaApi, signJwt, startFakeMonolith, type FakeMonolith } from "./fakeMonolith.js";

const OPS_TOKEN = "ops-token-f7";
const A = { userId: "u-ana", tenantId: "t-pulperia", role: "OWNER", email: "ana@example.com" };
const A2 = { userId: "u-beto", tenantId: "t-pulperia", role: "VENDEDOR" };
const B = { userId: "u-carla", tenantId: "t-ferreteria", role: "OWNER" };
const JWT_A = signJwt(A);
const JWT_A2 = signJwt(A2);
const JWT_B = signJwt(B);

let mono: FakeMonolith;
let app: HttpApp;
let url: URL;

function makeApp(rateLimit = 1000): HttpApp {
  return createHttpApp({
    ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t-ops-env" },
    client: { apiForToken: (jwt) => createHttpNortexApi({ baseUrl: mono.url, token: jwt }) },
    rateLimiter: new RateLimiter(rateLimit),
  });
}

beforeAll(async () => {
  mono = await startFakeMonolith({ "t-pulperia": createMockNortexApi(), "t-ferreteria": createFerreteriaApi() });
  app = makeApp();
  const addr = await listen(app, 0, "127.0.0.1");
  url = new URL(`http://127.0.0.1:${addr.port}/mcp`);
});
afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await mono.close();
});
afterEach(() => {
  mono.revoked.clear();
  mono.down.value = false;
  vi.restoreAllMocks();
});

async function connect(token: string, target: URL = url) {
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(target, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
const textOf = (r: unknown) =>
  ((r as { content: Array<{ text: string }> }).content ?? []).map((c) => c.text).join(" ");
const probes = () => mono.calls.filter((c) => c.path === PROBE_PATH && c.query.pageSize === "1" && !c.query.search);

const initBody = (id = 1) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
  });
const rawPost = (headers: Record<string, string>, body: string = initBody()) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });

describe("F7 · JWT válido fija SU tenant", () => {
  it("initialize hace UNA sonda al monolito; las tools leen datos del tenant del token", async () => {
    const before = mono.calls.length;
    const client = await connect(JWT_A);
    const afterInit = mono.calls.slice(before);
    expect(afterInit).toHaveLength(1); // exactamente una sonda
    expect(afterInit[0]).toMatchObject({ tenantId: "t-pulperia", path: PROBE_PATH, query: { page: "1", pageSize: "1" } });

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(mono.calls.length).toBe(before + 1); // listTools no toca el monolito ni re-sondea

    const r = await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } });
    expect(textOf(r)).toMatch(/Queso frito/);
    const used = mono.calls.slice(before);
    expect(used.every((c) => c.tenantId === "t-pulperia" && c.userId === "u-ana")).toBe(true);
    await client.close();
  });

  it("la auditoría registra tenant/usuario/rol/modo de la sesión y NUNCA el JWT", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(JWT_A);
    await client.callTool({ name: "ventas_hoy", arguments: {} });
    await client.close();
    const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
    const audit = lines.map((l) => JSON.parse(l)).find((e) => e.event === "tool_call" && e.tool === "ventas_hoy");
    expect(audit).toMatchObject({ tenant: "t-pulperia", userId: "u-ana", role: "OWNER", mode: "client", status: "ok" });
    for (const l of lines) {
      expect(l).not.toContain(JWT_A);
      expect(l).not.toContain(JWT_A.split(".")[2]); // ni la firma suelta
      expect(l).not.toContain("ana@example.com"); // tampoco claims que no sean ids
    }
  });
});

describe("F7 · JWT inválido / vencido → 401 sin datos", () => {
  const assert401 = async (token: string) => {
    const r = await rawPost({ Authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(await r.text()).toBe("");
  };

  it("firma inválida (mismos claims, otro secreto): el monolito lo rechaza en la sonda → 401, sin sesión", async () => {
    const before = probes().length;
    const sessions = app.clientSessionCount();
    await assert401(signJwt(A, "secreto-falsificado"));
    expect(probes().length).toBe(before); // la sonda se intentó y el monolito dio 403: no se registra llamada servida
    expect(app.clientSessionCount()).toBe(sessions);
  });

  it("JWT vencido → 401 sin tocar el monolito", async () => {
    const before = mono.calls.length;
    await assert401(signJwt(A, undefined, -60));
    expect(mono.calls.length).toBe(before);
  });

  it("claims incompletos, tokens de capacidad (kind) y basura → 401 sin tocar el monolito", async () => {
    const before = mono.calls.length;
    await assert401(signJwt({ userId: "u-x", role: "OWNER" })); // sin tenantId
    await assert401(signJwt({ tenantId: "t-pulperia", role: "OWNER" })); // sin userId
    await assert401(signJwt({ userId: "u-x", tenantId: "t-pulperia" })); // sin role
    await assert401(signJwt({ driverId: "d-1", kind: "DRIVER", userId: "u", tenantId: "t-pulperia", role: "X" }));
    await assert401(signJwt({ pedidoId: "p", tenantId: "t-pulperia", kind: "PEDIDO_TRACKING", userId: "u", role: "X" }));
    await assert401("no-es-un-jwt");
    await assert401("a.b.c");
    expect(mono.calls.length).toBe(before);
  });

  it("sin Authorization o esquema distinto de Bearer → 401", async () => {
    expect((await rawPost({})).status).toBe(401);
    expect((await rawPost({ Authorization: JWT_A })).status).toBe(401);
  });

  it("usuario revocado A MITAD de sesión: el monolito re-valida y la tool falla cerrada sin datos", async () => {
    const client = await connect(JWT_A);
    mono.revoked.add("u-ana");
    const out = textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));
    expect(out).toBe(MSG_SIN_ACCESO);
    expect(out).not.toMatch(/Queso|C\$|Principal/);
    await client.close();
  });

  it("monolito caído en la sonda → 503, sin sesión (fail closed)", async () => {
    mono.down.value = true;
    const sessions = app.clientSessionCount();
    const r = await rawPost({ Authorization: `Bearer ${JWT_A}` });
    expect(r.status).toBe(503);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(app.clientSessionCount()).toBe(sessions);
  });
});

describe("F7 · aislamiento entre tenants", () => {
  it("el token del tenant B ve SOLO lo de B, y el de A SOLO lo de A", async () => {
    const a = await connect(JWT_A);
    const b = await connect(JWT_B);
    const before = mono.calls.length;

    const bQueso = textOf(await b.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));
    const bTornillo = textOf(await b.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }));
    const aTornillo = textOf(await a.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }));
    const aQueso = textOf(await a.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));

    expect(bQueso).not.toMatch(/Queso frito|Principal|Sucursal/);
    expect(bTornillo).toMatch(/Tornillo de 3\/8/);
    expect(bTornillo).toMatch(/Bodega Ferretera/);
    expect(aTornillo).not.toMatch(/Tornillo|Ferretera/);
    expect(aQueso).toMatch(/Queso frito/);
    expect(aQueso).not.toMatch(/Ferretera/);

    // Ninguna llamada al monolito cruzó: cada sesión usó SOLO su JWT/tenant.
    const during = mono.calls.slice(before);
    const byUser = (u: string) => during.filter((c) => c.userId === u);
    expect(byUser("u-carla").every((c) => c.tenantId === "t-ferreteria")).toBe(true);
    expect(byUser("u-ana").every((c) => c.tenantId === "t-pulperia")).toBe(true);
    expect(byUser("u-carla").length).toBeGreaterThan(0);
    expect(byUser("u-ana").length).toBeGreaterThan(0);
    await a.close();
    await b.close();
  });

  it("ninguna tool acepta un parámetro de tenant; inyectarlo en los args no cambia nada", async () => {
    const a = await connect(JWT_A);
    const { tools } = await a.listTools();
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      expect(props.filter((p) => /tenant|negocio|empresa|company/i.test(p)), t.name).toEqual([]);
    }
    const before = mono.calls.length;
    const out = textOf(
      await a.callTool({ name: "buscar_producto", arguments: { q: "tornillo", tenantId: "t-ferreteria", tenant: "t-ferreteria" } }),
    );
    expect(out).not.toMatch(/Tornillo|Ferretera/);
    const during = mono.calls.slice(before);
    expect(during.every((c) => c.tenantId === "t-pulperia")).toBe(true);
    expect(during.every((c) => !Object.keys(c.query).some((k) => /tenant/i.test(k)))).toBe(true);
    await a.close();
  });

  it("secuestro de sesión: el JWT de B con el Mcp-Session-Id de A → 401 sin datos", async () => {
    const init = await rawPost({ Authorization: `Bearer ${JWT_A}` });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    await init.text();

    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "buscar_producto", arguments: { q: "queso" } },
    });
    const before = mono.calls.length;
    const hijack = await rawPost({ Authorization: `Bearer ${JWT_B}`, "Mcp-Session-Id": sid! }, call);
    expect(hijack.status).toBe(401);
    expect(await hijack.text()).toBe("");
    // Ni siquiera un JWT del MISMO tenant puede usar la sesión de otro usuario.
    const sameTenant = await rawPost({ Authorization: `Bearer ${JWT_A2}`, "Mcp-Session-Id": sid! }, call);
    expect(sameTenant.status).toBe(401);
    expect(mono.calls.length).toBe(before);

    // El dueño legítimo sí puede seguir.
    const own = await rawPost({ Authorization: `Bearer ${JWT_A}`, "Mcp-Session-Id": sid!, "Mcp-Protocol-Version": "2025-03-26" }, call);
    expect(own.status).toBe(200);
    expect(await own.text()).toMatch(/Queso frito/);
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${JWT_A}`, "Mcp-Session-Id": sid! } });
  });

  it("session id inexistente → 404; sin session id y sin initialize → 400", async () => {
    const call = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    expect((await rawPost({ Authorization: `Bearer ${JWT_A}`, "Mcp-Session-Id": "no-existe" }, call)).status).toBe(404);
    const before = mono.calls.length;
    expect((await rawPost({ Authorization: `Bearer ${JWT_A}` }, call)).status).toBe(400);
    expect(mono.calls.length).toBe(before); // sin initialize no hay sonda
  });

  it("DELETE cierra la sesión del cliente", async () => {
    const init = await rawPost({ Authorization: `Bearer ${JWT_B}` });
    const sid = init.headers.get("mcp-session-id")!;
    await init.text();
    const n = app.clientSessionCount();
    const del = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${JWT_B}`, "Mcp-Session-Id": sid } });
    expect(del.status).toBe(200);
    expect(app.clientSessionCount()).toBe(n - 1);
  });
});

describe("F7 · resolver_duda en sesión cliente", () => {
  it("responde con fuente y confianza sin tocar el monolito", async () => {
    const client = await connect(JWT_B);
    const before = mono.calls.length;
    const out = textOf(
      await client.callTool({
        name: "resolver_duda",
        arguments: { pregunta: "¿Puedo vender el mismo producto por caja y por unidad?" },
      }),
    );
    expect(out).toContain("+1 CAJA");
    expect(out).toMatch(/Fuente: Caso verificado/);
    expect(out).toMatch(/Confianza: alta/);
    expect(mono.calls.length).toBe(before);
    await client.close();
  });
});

describe("F7 · modo ops intacto (coexiste con el modo cliente)", () => {
  it("el token de operador abre sesión stateless con tenant y api del entorno", async () => {
    const before = mono.calls.length;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(OPS_TOKEN);
    const out = textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));
    await client.close();
    expect(out).toMatch(/Queso frito/);
    expect(mono.calls.length).toBe(before); // ops usa el api del entorno, no el monolito del cliente
    const audit = spy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .find((e) => e?.event === "tool_call");
    expect(audit).toMatchObject({ tenant: "t-ops-env", mode: "ops", status: "ok" });
    expect(audit.userId).toBeUndefined();
  });

  it("ops: sin Mcp-Session-Id en la respuesta; GET → 405", async () => {
    const r = await rawPost({ Authorization: `Bearer ${OPS_TOKEN}` });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect((await fetch(url, { headers: { Authorization: `Bearer ${OPS_TOKEN}` } })).status).toBe(405);
  });

  it("solo modo ops (sin cliente): un JWT válido de cliente → 401 sin sonda", async () => {
    const opsOnly = createHttpApp({
      ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t" },
      rateLimiter: new RateLimiter(100),
    });
    const addr = await listen(opsOnly, 0, "127.0.0.1");
    const before = mono.calls.length;
    const r = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${JWT_A}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initBody(),
    });
    expect(r.status).toBe(401);
    expect(mono.calls.length).toBe(before);
    await new Promise<void>((res) => opsOnly.close(() => res()));
  });
});

describe("F7 · rate limit por tenant+usuario de la sesión", () => {
  it("cada usuario tiene su cubeta; agotar la de uno no frena a otro usuario ni a otro tenant", async () => {
    const limited = makeApp(2);
    const addr = await listen(limited, 0, "127.0.0.1");
    const u = new URL(`http://127.0.0.1:${addr.port}/mcp`);
    const a = await connect(JWT_A, u);
    const a2 = await connect(JWT_A2, u);
    const b = await connect(JWT_B, u);
    const call = (c: Client) => c.callTool({ name: "resolver_duda", arguments: { pregunta: "¿cómo anulo una venta?" } });
    await call(a);
    await call(a);
    expect(textOf(await call(a))).toBe(MSG_RATE_LIMIT);
    expect(textOf(await call(a2))).not.toBe(MSG_RATE_LIMIT);
    expect(textOf(await call(b))).not.toBe(MSG_RATE_LIMIT);
    // Reconectar con el mismo JWT no resetea la cubeta (la clave es tenant:usuario, no la sesión).
    const aAgain = await connect(JWT_A, u);
    expect(textOf(await call(aAgain))).toBe(MSG_RATE_LIMIT);
    for (const c of [a, a2, b, aAgain]) await c.close();
    await new Promise<void>((res) => limited.close(() => res()));
  });
});

describe("F7 · decodeClientClaims y config", () => {
  it("decodifica claims sin verificar firma y exige userId/tenantId/role", () => {
    expect(decodeClientClaims(JWT_A)).toMatchObject({ tenantId: "t-pulperia", userId: "u-ana", role: "OWNER" });
    expect(decodeClientClaims(signJwt({ userId: "u", tenantId: "", role: "R" }))).toBeNull();
    expect(decodeClientClaims(signJwt({ userId: 5, tenantId: "t", role: "R" }))).toBeNull();
    expect(decodeClientClaims(signJwt(A, undefined, -1))).toBeNull();
    expect(decodeClientClaims(signJwt({ ...A, kind: "DRIVER" }))).toBeNull();
    expect(decodeClientClaims("x.%%%.y")).toBeNull();
  });

  it("config: modo cliente con NORTEX_API_URL; sin URL lanza; ambos modos coexisten", () => {
    expect(httpConfigFromEnv({ NORTEX_MCP_CLIENT_AUTH: "1", NORTEX_API_URL: "https://api.x" })).toMatchObject({
      clientApiUrl: "https://api.x",
    });
    expect(httpConfigFromEnv({ NORTEX_MCP_CLIENT_AUTH: "1", NORTEX_API_URL: "https://api.x" }).token).toBeUndefined();
    expect(() => httpConfigFromEnv({ NORTEX_MCP_CLIENT_AUTH: "1" })).toThrow(/NORTEX_API_URL/);
    const both = httpConfigFromEnv({ NORTEX_MCP_HTTP_TOKEN: "x", NORTEX_MCP_CLIENT_AUTH: "true", NORTEX_API_URL: "https://api.x" });
    expect(both).toMatchObject({ token: "x", clientApiUrl: "https://api.x" });
    // NORTEX_API_URL sola (sin el flag) NO activa el modo cliente.
    expect(() => httpConfigFromEnv({ NORTEX_API_URL: "https://api.x" })).toThrow();
  });

  it("createHttpApp sin ningún modo lanza", () => {
    expect(() => createHttpApp({ rateLimiter: new RateLimiter(1) })).toThrow(/fail closed/);
  });
});
