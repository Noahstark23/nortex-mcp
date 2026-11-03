/**
 * MCP-CONNECT-01 — ruta personal `/mcp/k/<token>` («pegar el enlace y listo»).
 *
 * La ruta debe comportarse EXACTAMENTE como el Bearer por header: misma sonda,
 * mismo tenant fijado por el token, misma sesión atada al SHA-256 del token,
 * misma cubeta de rate limit (`opaque:<sha256>`), misma auditoría sin token.
 * Cadena completa real contra el monolito FALSO de F7/F7.1, como opaqueAuth.
 */
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMockNortexApi } from "../src/mock.js";
import { createHttpNortexApi } from "../src/nortexApi.js";
import { RateLimiter } from "../src/rateLimit.js";
import { MSG_RATE_LIMIT } from "../src/tools.js";
import {
  PROBE_PATH,
  createHttpApp,
  isOpaqueTokenForm,
  listen,
  personalTokenOfPath,
  type HttpApp,
} from "../src/http.js";
import { createFerreteriaApi, makeOpaqueToken, signJwt, startFakeMonolith, type FakeMonolith } from "./fakeMonolith.js";

const OPS_TOKEN = "ops-token-connect01";
let mono: FakeMonolith;
let app: HttpApp;
let url: URL; // http://127.0.0.1:<port>/mcp
let NXT_A: string; // pulpería
let NXT_A_BIS: string; // pulpería, otro token del mismo negocio
let NXT_B: string; // ferretería
const JWT_A = signJwt({ userId: "u-ana", tenantId: "t-pulperia", role: "OWNER" });
/** Cada llamada a apiForToken = un intento de sonda. Si no crece, no se tocó la red. */
const probeTokens: string[] = [];

function makeApp(rateLimit = 1000, now?: () => number): HttpApp {
  return createHttpApp({
    ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t-ops-env" },
    client: {
      apiForToken: (token) => {
        probeTokens.push(token);
        return createHttpNortexApi({ baseUrl: mono.url, token });
      },
      ...(now ? { now } : {}),
    },
    rateLimiter: new RateLimiter(rateLimit),
  });
}
const closeApp = (a: HttpApp) => new Promise<void>((r) => a.close(() => r()));
const personalUrl = (token: string, base: URL = url) => new URL(`/mcp/k/${token}`, base);

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

/** Cliente MCP oficial contra la ruta personal, SIN header Authorization. */
async function connectPersonal(token: string, base: URL = url) {
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(personalUrl(token, base)));
  return client;
}
/** Cliente MCP oficial contra /mcp con header (la ruta de siempre). */
async function connectHeader(token: string) {
  const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
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
const rawPost = (target: URL, headers: Record<string, string> = {}, body: string = initBody()) =>
  fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
async function rawInitPersonal(token: string): Promise<string> {
  const r = await rawPost(personalUrl(token));
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("mcp-session-id")!;
}
const inSession = (token: string | null, sid: string) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  "Mcp-Session-Id": sid,
  "Mcp-Protocol-Version": "2025-03-26",
});

describe("CONNECT-01 · (a) token válido por la ruta personal, sin header", () => {
  it("initialize hace UNA sonda con el token de la ruta; listTools trae las 10 y no re-sondea", async () => {
    const probesBefore = probeTokens.length;
    const callsBefore = mono.calls.length;
    const client = await connectPersonal(NXT_A);
    expect(probeTokens.slice(probesBefore)).toEqual([NXT_A]);
    const probe = mono.calls.slice(callsBefore);
    expect(probe).toHaveLength(1);
    expect(probe[0]).toMatchObject({ authKind: "opaque", tenantId: "t-pulperia", path: PROBE_PATH });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(mono.calls.length).toBe(callsBefore + 1);
    await client.close();
  });

  it("una llamada de lectura responde los datos del tenant DEL TOKEN (y ventas_hoy también)", async () => {
    const client = await connectPersonal(NXT_A);
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }))).toMatch(/Queso frito/);
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }))).not.toMatch(
      /Tornillo|Ferretera/,
    );
    expect(textOf(await client.callTool({ name: "ventas_hoy", arguments: {} }))).toMatch(/vendiste|ventas/i);
    await client.close();
  });

  it("GET y DELETE de la sesión funcionan por la ruta personal (mismos métodos que /mcp)", async () => {
    const sid = await rawInitPersonal(NXT_B);
    const n = app.clientSessionCount();
    const own = await rawPost(personalUrl(NXT_B), inSession(null, sid), callBody("buscar_producto", { q: "tornillo" }));
    expect(own.status).toBe(200);
    expect(await own.text()).toMatch(/Tornillo de 3\/8/);
    const del = await fetch(personalUrl(NXT_B), { method: "DELETE", headers: inSession(null, sid) });
    expect(del.status).toBe(200);
    expect(app.clientSessionCount()).toBe(n - 1);
  });
});

describe("CONNECT-01 · (b) token inválido o revocado → 401", () => {
  it("bien formado pero nunca emitido, o revocado: la sonda lo rechaza → 401 sin sesión", async () => {
    const sessions = app.clientSessionCount();
    for (const bad of [makeOpaqueToken()]) {
      const r = await rawPost(personalUrl(bad));
      expect(r.status).toBe(401);
      expect(r.headers.get("mcp-session-id")).toBeNull();
      expect(await r.text()).toBe("");
    }
    const revoked = mono.issueOpaque("t-pulperia", "u-ana");
    mono.revokeOpaque(revoked);
    const r = await rawPost(personalUrl(revoked));
    expect(r.status).toBe(401);
    expect(app.clientSessionCount()).toBe(sessions);
  });

  it("forma inválida → 401 SIN sonda y sin tocar el monolito", async () => {
    const probesBefore = probeTokens.length;
    const callsBefore = mono.calls.length;
    const sessions = app.clientSessionCount();
    const badForms = [
      "", // /mcp/k/ pelado
      "nxt_",
      "nxt_corto",
      "nxt_" + "A".repeat(44), // demasiado largo
      "nxt_" + "A".repeat(42) + "!", // largo justo, carácter ilegal
      JWT_A, // un JWT en la ruta no es un acceso para IA
      OPS_TOKEN, // el token de ops tampoco
    ];
    for (const bad of badForms) {
      const r = await rawPost(personalUrl(bad));
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
      expect(await r.text()).toBe("");
    }
    expect(probeTokens.length).toBe(probesBefore); // jamás se construyó la sonda
    expect(mono.calls.length).toBe(callsBefore);
    expect(app.clientSessionCount()).toBe(sessions);
  });

  it("monolito caído en la sonda → 503 sin sesión (fail closed, igual que por header)", async () => {
    mono.down.value = true;
    const sessions = app.clientSessionCount();
    const r = await rawPost(personalUrl(NXT_A));
    expect(r.status).toBe(503);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(app.clientSessionCount()).toBe(sessions);
  });

  it("sin modo cliente (solo ops): la ruta personal → 401 sin sonda", async () => {
    const opsOnly = createHttpApp({
      ops: { token: OPS_TOKEN, api: createMockNortexApi(), tenant: "t" },
      rateLimiter: new RateLimiter(100),
    });
    const addr = await listen(opsOnly, 0, "127.0.0.1");
    const probesBefore = probeTokens.length;
    const r = await rawPost(personalUrl(NXT_A, new URL(`http://127.0.0.1:${addr.port}/mcp`)));
    expect(r.status).toBe(401);
    expect(probeTokens.length).toBe(probesBefore);
    await closeApp(opsOnly);
  });

  it("una ruta que no es /mcp ni /mcp/k/<token> sigue siendo 404", async () => {
    expect((await rawPost(new URL("/otra", url))).status).toBe(404);
    expect((await rawPost(new URL(`/mcp/k/${NXT_A}/extra`, url))).status).toBe(404);
    expect((await rawPost(new URL("/mcp/k", url))).status).toBe(404);
  });
});

describe("CONNECT-01 · (c) el tenant sale SOLO del token de la ruta", () => {
  it("header contradictorio (otro token válido, un JWT o el de ops) → 401 sin sonda", async () => {
    const probesBefore = probeTokens.length;
    const callsBefore = mono.calls.length;
    for (const other of [NXT_A, JWT_A, OPS_TOKEN]) {
      const r = await rawPost(personalUrl(NXT_B), { Authorization: `Bearer ${other}` });
      expect(r.status).toBe(401);
      expect(await r.text()).toBe("");
    }
    expect(probeTokens.length).toBe(probesBefore);
    expect(mono.calls.length).toBe(callsBefore);
  });

  it("header IDÉNTICO al de la ruta no estorba: conecta y sirve su tenant", async () => {
    const r = await rawPost(personalUrl(NXT_B), { Authorization: `Bearer ${NXT_B}` });
    expect(r.status).toBe(200);
    const sid = r.headers.get("mcp-session-id")!;
    await r.text();
    const call = await rawPost(personalUrl(NXT_B), inSession(null, sid), callBody("buscar_producto", { q: "tornillo" }));
    expect(call.status).toBe(200);
    expect(await call.text()).toMatch(/Tornillo de 3\/8/);
    await fetch(personalUrl(NXT_B), { method: "DELETE", headers: inSession(null, sid) });
  });

  it("un query ?tenantId=… no cruza datos: manda el token", async () => {
    const target = personalUrl(NXT_A);
    target.search = "?tenantId=t-ferreteria";
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(target));
    const before = mono.calls.length;
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }))).toMatch(/Queso frito/);
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "tornillo" } }))).not.toMatch(
      /Tornillo/,
    );
    expect(mono.calls.slice(before).every((c) => c.tenantId === "t-pulperia")).toBe(true);
    await client.close();
  });

  it("la sesión abierta por la ruta personal es del token: otro bearer en /mcp → 401; el mismo token en /mcp → 200", async () => {
    const sid = await rawInitPersonal(NXT_A);
    const before = mono.calls.length;
    for (const other of [NXT_A_BIS, NXT_B, JWT_A]) {
      const r = await rawPost(url, inSession(other, sid), callBody());
      expect(r.status).toBe(401);
      expect(await r.text()).toBe("");
    }
    expect(mono.calls.length).toBe(before);
    const own = await rawPost(url, inSession(NXT_A, sid), callBody());
    expect(own.status).toBe(200);
    expect(await own.text()).toMatch(/Queso frito/);
    await fetch(url, { method: "DELETE", headers: inSession(NXT_A, sid) });
  });
});

describe("CONNECT-01 · rate limit por hash del token (no por IP) en la ruta personal", () => {
  it("dos tokens del mismo negocio no comparten cubeta; reconectar por la ruta no la resetea", async () => {
    const limited = makeApp(2);
    const addr = await listen(limited, 0, "127.0.0.1");
    const u = new URL(`http://127.0.0.1:${addr.port}/mcp`);
    const a = await connectPersonal(NXT_A, u);
    const aBis = await connectPersonal(NXT_A_BIS, u);
    const call = (c: Client) => c.callTool({ name: "resolver_duda", arguments: { pregunta: "¿cómo anulo una venta?" } });
    await call(a);
    await call(a);
    expect(textOf(await call(a))).toBe(MSG_RATE_LIMIT);
    expect(textOf(await call(aBis))).not.toBe(MSG_RATE_LIMIT);
    const aAgain = await connectPersonal(NXT_A, u);
    expect(textOf(await call(aAgain))).toBe(MSG_RATE_LIMIT);
    for (const c of [a, aBis, aAgain]) await c.close();
    await closeApp(limited);
  });
});

describe("CONNECT-01 · auditoría: hash, nunca el token, también por la ruta personal", () => {
  it("la línea de auditoría trae authKind opaque y subject por hash; el token no aparece en ningún log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connectPersonal(NXT_A);
    await client.callTool({ name: "ventas_hoy", arguments: {} });
    await client.close();
    const lines = spy.mock.calls.map((c) => c.map(String).join(" "));
    const audit = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .find((e) => e?.event === "tool_call" && e.tool === "ventas_hoy");
    const hash = createHash("sha256").update(NXT_A).digest("hex");
    expect(audit).toMatchObject({ tenant: null, mode: "client", authKind: "opaque", subject: `opaque:${hash}`, status: "ok" });
    const secret = NXT_A.slice(4);
    for (const l of lines) {
      expect(l).not.toContain(NXT_A);
      expect(l).not.toContain(secret.slice(0, 16));
      expect(l).not.toContain(secret.slice(-16));
    }
  });
});

describe("CONNECT-01 · (d) regresión: /mcp por header no cambió", () => {
  it("la ruta de siempre sigue conectando con el mismo app (header Bearer)", async () => {
    const client = await connectHeader(NXT_A);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(textOf(await client.callTool({ name: "buscar_producto", arguments: { q: "queso" } }))).toMatch(/Queso frito/);
    await client.close();
  });

  it("helpers: personalTokenOfPath e isOpaqueTokenForm", () => {
    expect(personalTokenOfPath("/mcp/k/abc")).toBe("abc");
    expect(personalTokenOfPath("/mcp/k/")).toBe("");
    expect(personalTokenOfPath("/mcp")).toBeNull();
    expect(personalTokenOfPath("/mcp/k")).toBeNull();
    expect(isOpaqueTokenForm(NXT_A)).toBe(true);
    expect(isOpaqueTokenForm("nxt_corto")).toBe(false);
    expect(isOpaqueTokenForm(JWT_A)).toBe(false);
  });
});
