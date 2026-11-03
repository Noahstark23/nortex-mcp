/**
 * F7.1 — modo cliente con el token opaco `nxt_` («acceso para IA» del monolito).
 *
 * Cadena completa real: cliente MCP oficial → transporte HTTP del MCP →
 * createHttpNortexApi (fetch real) → monolito FALSO que guarda solo el SHA-256
 * de cada token opaco y sirve los datos del tenant de ESA fila (no hay claims).
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockNortexApi } from "../src/mock.js";
import { createHttpNortexApi } from "../src/nortexApi.js";
import { RateLimiter } from "../src/rateLimit.js";
import { createNortexMcpServer, rateLimitKey } from "../src/server.js";
import { MSG_RATE_LIMIT, MSG_SIN_ACCESO } from "../src/tools.js";
import {
  PROBE_PATH,
  createHttpApp,
  isOpaqueToken,
  listen,
  opaqueSubject,
  type HttpApp,
} from "../src/http.js";
import { createFerreteriaApi, makeOpaqueToken, signJwt, startFakeMonolith, type FakeMonolith } from "./fakeMonolith.js";

const OPS_TOKEN = "ops-token-f71";
let mono: FakeMonolith;
let app: HttpApp;
let url: URL;
let NXT_A: string; // pulpería, emitido por Ana
let NXT_A_BIS: string; // pulpería, OTRO token emitido por Ana
let NXT_B: string; // ferretería
const JWT_A = signJwt({ userId: "u-ana", tenantId: "t-pulperia", role: "OWNER" });

function makeApp(rateLimit = 1000, now?: () => number): HttpApp {
  return createHttpApp({
    ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t-ops-env" },
    client: {
      apiForToken: (token) => createHttpNortexApi({ baseUrl: mono.url, token }),
      ...(now ? { now } : {}),
    },
    rateLimiter: new RateLimiter(rateLimit),
  });
}
const closeApp = (a: HttpApp) => new Promise<void>((r) => a.close(() => r()));

beforeAll(async () => {
  mono = await startFakeMonolith({ "t-pulperia": createMockNortexApi(), "t-ferreteria": createFerreteriaApi() });
  NXT_A = mono.issueOpaque("t-pulperia", "u-ana");
  NXT_A_BIS = mono.issueOpaque("t-pulperia", "u-ana");
  NXT_B = mono.issueOpaque("t-ferreteria", "u-carla");
  app = makeApp();
  const addr = await listen(app, 0, "127.0.0.1");
  url = new URL(`http://127.0.0.1:${addr.port}/mcp`);
});
afterAll(async () => {
  await closeApp(app);
  await mono.close();
});
afterEach(() => {
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

const initBody = () =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } },
  });
const callBody = (name = "buscar_producto", args: Record<string, unknown> = { q: "queso" }) =>
  JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
const rawPost = (headers: Record<string, string>, body: string = initBody(), target: URL = url) =>
  fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
async function rawInit(token: string, target: URL = url): Promise<string> {
  const r = await rawPost({ Authorization: `Bearer ${token}` }, initBody(), target);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("mcp-session-id")!;
}
const inSession = (token: string, sid: string) => ({
  Authorization: `Bearer ${token}`,
  "Mcp-Session-Id": sid,
  "Mcp-Protocol-Version": "2025-03-26",
});

describe("F7.1 · token opaco válido → sesión tras UNA sonda", () => {
  it("initialize hace exactamente una sonda con el token opaco; listTools no re-sondea", async () => {
    const before = mono.calls.length;
    const client = await connect(NXT_A);
    const afterInit = mono.calls.slice(before);
    expect(afterInit).toHaveLength(1);
    expect(afterInit[0]).toMatchObject({
      authKind: "opaque",
      tenantId: "t-pulperia",
      path: PROBE_PATH,
      query: { page: "1", pageSize: "1" },
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(mono.calls.length).toBe(before + 1);
    await client.close();
  });

  it("las tools de datos funcionan: el monolito sirve por el token, no por claims del MCP", async () => {
    const a = await connect(NXT_A);
    const b = await connect(NXT_B);
    const before = mono.calls.length;
    const aQueso = textOf(await a.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));
    const aTornillo = textOf(await a.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }));
    const bTornillo = textOf(await b.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }));
    const bQueso = textOf(
      await b.callTool({ name: "buscar_producto", arguments: { q: "queso", tenantId: "t-pulperia" } }),
    );
    expect(aQueso).toMatch(/Queso frito/);
    expect(aTornillo).not.toMatch(/Tornillo|Ferretera/);
    expect(bTornillo).toMatch(/Tornillo de 3\/8/);
    expect(bQueso).not.toMatch(/Queso frito|Principal|Sucursal/); // tenant inyectado en args: ignorado
    const during = mono.calls.slice(before);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((c) => c.authKind === "opaque")).toBe(true);
    expect(during.filter((c) => c.userId === "u-ana").every((c) => c.tenantId === "t-pulperia")).toBe(true);
    expect(during.filter((c) => c.userId === "u-carla").every((c) => c.tenantId === "t-ferreteria")).toBe(true);
    expect(during.every((c) => !Object.keys(c.query).some((k) => /tenant/i.test(k)))).toBe(true);
    expect(textOf(await a.callTool({ name: "ventas_hoy", arguments: {} }))).toMatch(/vendiste|ventas/i);
    await a.close();
    await b.close();
  });

  it("resolver_duda en sesión opaca responde sin llamadas al monolito", async () => {
    const client = await connect(NXT_B);
    const before = mono.calls.length;
    const out = textOf(
      await client.callTool({
        name: "resolver_duda",
        arguments: { pregunta: "¿Puedo vender el mismo producto por caja y por unidad?" },
      }),
    );
    expect(out).toContain("+1 CAJA");
    expect(out).toMatch(/Fuente:/);
    expect(mono.calls.length).toBe(before);
    await client.close();
  });

  it("DELETE cierra la sesión opaca", async () => {
    const sid = await rawInit(NXT_B);
    const n = app.clientSessionCount();
    const del = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${NXT_B}`, "Mcp-Session-Id": sid } });
    expect(del.status).toBe(200);
    expect(app.clientSessionCount()).toBe(n - 1);
    expect((await rawPost(inSession(NXT_B, sid), callBody())).status).toBe(404);
  });
});

describe("F7.1 · token opaco inválido / revocado → 401 sin sesión", () => {
  const assert401 = async (token: string) => {
    const sessions = app.clientSessionCount();
    const r = await rawPost({ Authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(await r.text()).toBe("");
    expect(app.clientSessionCount()).toBe(sessions);
  };

  it("desconocido, mal formado o revocado: el monolito lo rechaza en la sonda → 401", async () => {
    const before = mono.calls.length;
    await assert401(makeOpaqueToken()); // bien formado pero nunca emitido
    await assert401("nxt_");
    await assert401("nxt_corto");
    const revoked = mono.issueOpaque("t-pulperia", "u-ana");
    mono.revokeOpaque(revoked);
    await assert401(revoked);
    expect(mono.calls.length).toBe(before); // ninguna llamada servida: no se creó sesión
  });

  it("revocado A MITAD de sesión: la tool falla cerrada sin datos", async () => {
    const token = mono.issueOpaque("t-pulperia", "u-ana");
    const client = await connect(token);
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }))).toMatch(/Queso frito/);
    mono.revokeOpaque(token);
    const out = textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }));
    expect(out).toBe(MSG_SIN_ACCESO);
    expect(out).not.toMatch(/Queso|C\$|Principal/);
    await client.close();
  });

  it("monolito caído en la sonda → 503 sin sesión (fail closed)", async () => {
    mono.down.value = true;
    const sessions = app.clientSessionCount();
    const r = await rawPost({ Authorization: `Bearer ${NXT_A}` });
    expect(r.status).toBe(503);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(app.clientSessionCount()).toBe(sessions);
  });

  it("solo modo ops (sin cliente): un token opaco válido → 401 sin sonda", async () => {
    const opsOnly = createHttpApp({
      ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t" },
      rateLimiter: new RateLimiter(100),
    });
    const addr = await listen(opsOnly, 0, "127.0.0.1");
    const before = mono.calls.length;
    const r = await rawPost({ Authorization: `Bearer ${NXT_A}` }, initBody(), new URL(`http://127.0.0.1:${addr.port}/mcp`));
    expect(r.status).toBe(401);
    expect(mono.calls.length).toBe(before);
    await closeApp(opsOnly);
  });
});

describe("F7.1 · la sesión opaca es SOLO de su token", () => {
  it("otro token opaco (aun del mismo usuario), su JWT u otro negocio con ese Mcp-Session-Id → 401", async () => {
    const sid = await rawInit(NXT_A);
    const before = mono.calls.length;
    for (const other of [NXT_A_BIS, JWT_A, NXT_B, makeOpaqueToken()]) {
      const r = await rawPost(inSession(other, sid), callBody());
      expect(r.status).toBe(401);
      expect(await r.text()).toBe("");
    }
    expect(mono.calls.length).toBe(before);
    const own = await rawPost(inSession(NXT_A, sid), callBody());
    expect(own.status).toBe(200);
    expect(await own.text()).toMatch(/Queso frito/);
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${NXT_A}`, "Mcp-Session-Id": sid } });
  });

  it("una sesión JWT tampoco se puede usar con un token opaco", async () => {
    const sid = await rawInit(JWT_A);
    const r = await rawPost(inSession(NXT_A, sid), callBody());
    expect(r.status).toBe(401);
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${JWT_A}`, "Mcp-Session-Id": sid } });
  });

  it("vence por inactividad de la sesión MCP (30 min): sin exp inventado", async () => {
    let t = Date.now();
    const timed = makeApp(1000, () => t);
    const addr = await listen(timed, 0, "127.0.0.1");
    const u = new URL(`http://127.0.0.1:${addr.port}/mcp`);
    const sid = await rawInit(NXT_A, u);
    t += 29 * 60_000; // uso dentro de la ventana: sigue viva (y renueva lastSeen)
    expect((await rawPost(inSession(NXT_A, sid), callBody(), u)).status).toBe(200);
    t += 29 * 60_000; // 58 min desde el alta, pero 29 sin uso: viva (no hay exp de token)
    expect((await rawPost(inSession(NXT_A, sid), callBody(), u)).status).toBe(200);
    t += 31 * 60_000;
    expect((await rawPost(inSession(NXT_A, sid), callBody(), u)).status).toBe(401);
    expect(timed.clientSessionCount()).toBe(0);
    await closeApp(timed);
  });
});

describe("F7.1 · rate limit por hash del token", () => {
  it("dos tokens distintos (mismo negocio y emisor) no comparten cubeta; reconectar no la resetea", async () => {
    const limited = makeApp(2);
    const addr = await listen(limited, 0, "127.0.0.1");
    const u = new URL(`http://127.0.0.1:${addr.port}/mcp`);
    const a = await connect(NXT_A, u);
    const aBis = await connect(NXT_A_BIS, u);
    const jwt = await connect(JWT_A, u);
    const call = (c: Client) => c.callTool({ name: "resolver_duda", arguments: { pregunta: "¿cómo anulo una venta?" } });
    await call(a);
    await call(a);
    expect(textOf(await call(a))).toBe(MSG_RATE_LIMIT);
    expect(textOf(await call(aBis))).not.toBe(MSG_RATE_LIMIT);
    expect(textOf(await call(jwt))).not.toBe(MSG_RATE_LIMIT); // el JWT del mismo usuario tiene su propia cubeta
    const aAgain = await connect(NXT_A, u);
    expect(textOf(await call(aAgain))).toBe(MSG_RATE_LIMIT);
    for (const c of [a, aBis, jwt, aAgain]) await c.close();
    await closeApp(limited);
  });
});

describe("F7.1 · auditoría: authKind + hash, nunca el token", () => {
  it("la línea de una llamada opaca trae tenant null, authKind opaque y subject por hash; el token no aparece", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(NXT_A);
    await client.callTool({ name: "ventas_hoy", arguments: {} });
    await client.close();
    const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
    const audit = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e?.event === "tool_call" && e.tool === "ventas_hoy");
    const hash = createHash("sha256").update(NXT_A).digest("hex");
    expect(audit).toMatchObject({
      tenant: null,
      mode: "client",
      authKind: "opaque",
      subject: `opaque:${hash}`,
      status: "ok",
    });
    expect(audit.userId).toBeUndefined();
    expect(audit.role).toBeUndefined();
    const secret = NXT_A.slice(4); // la parte aleatoria, sin el prefijo
    for (const l of lines) {
      expect(l).not.toContain(NXT_A);
      expect(l).not.toContain(secret);
      expect(l).not.toContain(secret.slice(0, 16));
      expect(l).not.toContain(secret.slice(-16));
    }
  });

  it("una sesión JWT queda auditada con authKind jwt (y sus ids de siempre)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connect(JWT_A);
    await client.callTool({ name: "ventas_hoy", arguments: {} });
    await client.close();
    const audit = spy.mock.calls
      .map((c) => { try { return JSON.parse(String(c[0])); } catch { return null; } })
      .find((e) => e?.event === "tool_call" && e.tool === "ventas_hoy");
    expect(audit).toMatchObject({ tenant: "t-pulperia", userId: "u-ana", role: "OWNER", mode: "client", authKind: "jwt" });
    expect(audit.subject).toBeUndefined();
  });
});

describe("F7.1 · helpers", () => {
  it("isOpaqueToken distingue nxt_ de JWT/ops; opaqueSubject es SHA-256 hex con prefijo", () => {
    expect(isOpaqueToken(NXT_A)).toBe(true);
    expect(isOpaqueToken(JWT_A)).toBe(false);
    expect(isOpaqueToken(OPS_TOKEN)).toBe(false);
    expect(isOpaqueToken("NXT_abc")).toBe(false);
    expect(opaqueSubject(NXT_A)).toMatch(/^opaque:[0-9a-f]{64}$/);
    expect(opaqueSubject(NXT_A)).not.toBe(opaqueSubject(NXT_A_BIS));
    expect(opaqueSubject(NXT_A)).not.toContain(NXT_A.slice(4));
  });

  it("rateLimitKey: subject manda; sin tenant ni subject el servidor no se construye (fail closed)", () => {
    expect(rateLimitKey({ tenant: null, subject: "opaque:abc" })).toBe("opaque:abc");
    expect(rateLimitKey({ tenant: "t", userId: "u" })).toBe("t:u");
    expect(rateLimitKey({ tenant: "t" })).toBe("t");
    expect(() =>
      createNortexMcpServer({ api: createMockNortexApi(), tenant: null, mode: "client", rateLimiter: new RateLimiter(1) }),
    ).toThrow(/fail closed/);
  });
});
