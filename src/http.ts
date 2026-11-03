/**
 * Transporte Streamable HTTP (spec MCP) para nortex-mcp — F4 + F7.
 *
 * Dos modos de auth, que pueden coexistir en el mismo proceso. Precedencia
 * por request: (1) si el bearer coincide con NORTEX_MCP_HTTP_TOKEN → OPS;
 * (2) si no, y el modo cliente está activo → CLIENTE; (3) si no → 401.
 *
 * OPS (F4, intacto): `Authorization: Bearer <NORTEX_MCP_HTTP_TOKEN>`, comparado
 * en tiempo constante. STATELESS (`sessionIdGenerator: undefined`): un servidor
 * + transport por request, tenant y api del entorno (service token).
 *
 * CLIENTE (F7): `Authorization: Bearer <JWT de Nortex del cliente>` — el mismo
 * token con el que la app autentica. El MCP NO tiene el secreto JWT ni verifica
 * la firma: la verificación real es del monolito, que re-valida el JWT (y al
 * usuario contra BD) en CADA llamada. Flujo:
 *   1. Sin sesión, solo se acepta `initialize`. Se decodifican los claims (sin
 *      firma) y se exige {userId, tenantId, role}; tokens con `kind` (repartidor,
 *      tracking) o vencidos se rechazan sin tocar la red.
 *   2. UNA sonda autenticada y liviana al monolito con ese JWT
 *      (GET /api/products?page=1&pageSize=1). 401/403 → 401 al cliente sin
 *      cuerpo; cualquier otro fallo → 503. Fail closed: no se crea sesión.
 *   3. Sesión MCP con estado (`Mcp-Session-Id`): tenant/usuario/rol fijados por
 *      la sesión y un NortexApi POR SESIÓN construido con el JWT del cliente.
 *      La sesión queda atada al SHA-256 del JWT: otro bearer con ese session id
 *      → 401 (sin secuestro de sesión). Ninguna tool acepta tenant.
 *
 * CLIENTE con token opaco (F7.1): `Authorization: Bearer nxt_…` — el «acceso
 * para IA» que el dueño genera en Nortex → Configuración (solo lectura,
 * revocable; el monolito guarda solo su SHA-256). No es un JWT: no hay claims
 * que leer. Validación = la MISMA sonda (200 → sesión; 401/403 → 401; resto →
 * 503). La sesión queda atada al SHA-256 del token con tenant/usuario/rol en
 * null: el monolito acota cada llamada por el propio token. Rate limit y
 * auditoría por `opaque:<sha256 hex>`. Sin `exp` propio: vence por inactividad
 * de la sesión MCP (30 min) o DELETE; la revocación la aplica el monolito en
 * cada llamada.
 * Ni el JWT ni el token opaco se loguean o auditan: solo ids / hash.
 *
 * Ruta personal (MCP-CONNECT-01): el MISMO endpoint servido también bajo
 * `/mcp/k/<token>`, para clientes que solo aceptan una URL (pegar el enlace y
 * listo, sin configurar headers). El token de la ruta se trata EXACTAMENTE
 * como si viniera en `Authorization: Bearer <token>`: entra a `handleClient`
 * por el mismo camino, con la misma sonda, el mismo tenant fijado por el
 * token y la misma identidad de rate limit/auditoría (`opaque:<sha256>`).
 * Reglas propias de la ruta, todas fail closed:
 *   - Forma: el segmento debe calzar el formato del monolito
 *     (`nxt_` + 32 bytes base64url). Si no, 401 sin sonda y sin efectos.
 *   - Contradicción: si además viene un header Authorization con OTRO bearer
 *     distinto al de la ruta → 401 (el tenant sale SOLO del token de la ruta).
 *   - Sin modo cliente activo, la ruta no existe como credencial: 401.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { RateLimiter, rateLimitFromEnv } from "./rateLimit.js";
import { tenantFromEnv } from "./audit.js";
import { createHttpNortexApi, NortexAuthError, type NortexApi } from "./nortexApi.js";
import { apiFromEnv, createNortexMcpServer } from "./server.js";

export const MCP_PATH = "/mcp";
export const DEFAULT_HTTP_PORT = 8931;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
/** Sonda de validación del JWT del cliente: la lectura más liviana que ya usa nortexApi. */
export const PROBE_PATH = "/api/products";
export const PROBE_QUERY = { page: 1, pageSize: 1 } as const;
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;
export const DEFAULT_MAX_SESSIONS = 1000;
/** Prefijo del token de acceso para IA del monolito (backend/services/mcpAccessTokens.ts). */
export const OPAQUE_TOKEN_PREFIX = "nxt_";
/** Forma exacta del token opaco: `nxt_` + 32 bytes base64url = 43 caracteres (TOKEN_PATTERN del monolito). */
export const OPAQUE_TOKEN_PATTERN = /^nxt_[A-Za-z0-9_-]{43}$/;
/** Prefijo de la ruta personal (MCP-CONNECT-01): `/mcp/k/<token>`. */
export const MCP_PERSONAL_PREFIX = "/mcp/k/";
const MAX_BODY_BYTES = 1_000_000;

export interface HttpConfig {
  /** Token de operador (modo ops). Opcional si el modo cliente está activo. */
  token?: string;
  /** URL del monolito para el modo cliente (NORTEX_MCP_CLIENT_AUTH=1). */
  clientApiUrl?: string;
  port: number;
  host: string;
}

/** Valida la config HTTP del entorno. Lanza (fail closed) si no hay ningún modo de auth. */
export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const token = env.NORTEX_MCP_HTTP_TOKEN || undefined;
  const clientOn = ["1", "true", "on"].includes((env.NORTEX_MCP_CLIENT_AUTH ?? "").toLowerCase());
  const clientApiUrl = clientOn ? env.NORTEX_API_URL || undefined : undefined;
  if (clientOn && !clientApiUrl) {
    throw new Error("NORTEX_MCP_CLIENT_AUTH requiere NORTEX_API_URL (el monolito valida el JWT del cliente).");
  }
  if (!token && !clientApiUrl) {
    throw new Error(
      "modo HTTP requiere NORTEX_MCP_HTTP_TOKEN (ops) y/o NORTEX_MCP_CLIENT_AUTH=1 + NORTEX_API_URL (clientes); no arranco sin auth.",
    );
  }
  const rawPort = env.MCP_HTTP_PORT;
  const port = rawPort === undefined || rawPort === "" ? DEFAULT_HTTP_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MCP_HTTP_PORT inválido: "${rawPort}".`);
  }
  return {
    ...(token ? { token } : {}),
    ...(clientApiUrl ? { clientApiUrl } : {}),
    port,
    host: env.MCP_HTTP_HOST || DEFAULT_HTTP_HOST,
  };
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Extrae el token de `Authorization: Bearer <token>` (null si no hay o el esquema es otro). */
/** ¿El bearer es un token opaco de acceso para IA? (forma, no validez: eso lo decide la sonda). */
export function isOpaqueToken(token: string): boolean {
  return token.startsWith(OPAQUE_TOKEN_PREFIX);
}

/** Identidad de rate limit/auditoría de un token opaco: `opaque:<sha256 hex>`. Nunca el token. */
export function opaqueSubject(token: string): string {
  return `opaque:${sha256(token).toString("hex")}`;
}

/** ¿El string calza la FORMA exacta del token opaco (no su validez: eso lo decide la sonda)? */
export function isOpaqueTokenForm(token: string): boolean {
  return OPAQUE_TOKEN_PATTERN.test(token);
}

/**
 * Si el path es de la ruta personal, devuelve el segmento crudo tras
 * `/mcp/k/` (puede ser cualquier cosa: la forma la juzga el llamador).
 * Devuelve null si el path no es de la ruta personal.
 */
export function personalTokenOfPath(path: string): string | null {
  return path.startsWith(MCP_PERSONAL_PREFIX) ? path.slice(MCP_PERSONAL_PREFIX.length) : null;
}

export function bearerOf(header: string | undefined): string | null {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  return m ? m[1] : null;
}

/** Comparación en tiempo constante (hash a largo fijo: timingSafeEqual exige igual longitud). */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const given = bearerOf(header);
  return timingSafeEqual(sha256(given ?? ""), sha256(token)) && given !== null;
}

export interface ClientClaims {
  tenantId: string;
  userId: string;
  role: string;
  /** exp del JWT en segundos epoch, si viene. */
  exp?: number;
}

/**
 * Decodifica (SIN verificar firma: eso lo hace el monolito en la sonda y en
 * cada llamada) el payload de un JWT de sesión de usuario de Nortex
 * (`{userId, tenantId, role, email?}`, backend/services/secrets.ts).
 * Devuelve null si no es un JWT, le faltan claims, trae `kind` (tokens de
 * repartidor/tracking: jamás son sesión de usuario) o ya venció.
 */
export function decodeClientClaims(token: string, nowMs: number = Date.now()): ClientClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.kind !== undefined) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
  const tenantId = str(p.tenantId);
  const userId = str(p.userId);
  const role = str(p.role);
  if (!tenantId || !userId || !role) return null;
  if (p.exp !== undefined) {
    if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null;
    if (p.exp * 1000 <= nowMs) return null;
  }
  return { tenantId, userId, role, ...(typeof p.exp === "number" ? { exp: p.exp } : {}) };
}

export interface OpsMode {
  /** NORTEX_MCP_HTTP_TOKEN. */
  token: string;
  /** Backend del entorno (service token o mock). */
  api: NortexApi;
  /** Tenant del entorno (NORTEX_TENANT_ID). */
  tenant: string;
}

export interface ClientMode {
  /** Construye el NortexApi de una sesión con el bearer del cliente (JWT o token opaco nxt_). */
  apiForToken: (token: string) => NortexApi;
  now?: () => number;
  sessionIdleMs?: number;
  maxSessions?: number;
}

export interface HttpAppOptions {
  ops?: OpsMode;
  client?: ClientMode;
  /** Compartido por ambos modos y todas las sesiones. */
  rateLimiter: RateLimiter;
}

interface ClientSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  tokenHash: Buffer;
  /** null en sesiones opacas (sin claims; tampoco exp). */
  claims: ClientClaims | null;
  lastSeen: number;
}

export interface HttpApp extends Server {
  /** Sesiones cliente vivas (solo para tests/diagnóstico: ids, nunca tokens). */
  clientSessionCount(): number;
}

function reject(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, headers).end();
}
const unauthorized = (res: ServerResponse) =>
  reject(res, 401, { "WWW-Authenticate": 'Bearer realm="nortex-mcp"' });

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("cuerpo demasiado grande");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  if (!opts.ops && !opts.client) throw new Error("createHttpApp: sin modo de auth (fail closed).");
  const { ops, client, rateLimiter } = opts;
  const now = client?.now ?? Date.now;
  const idleMs = client?.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const maxSessions = client?.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessions = new Map<string, ClientSession>();

  const dropSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close();
    void s.server.close();
  };
  const sessionExpired = (s: ClientSession, t: number) =>
    t - s.lastSeen > idleMs || (s.claims?.exp !== undefined && s.claims.exp * 1000 <= t);

  async function handleOps(req: IncomingMessage, res: ServerResponse, o: OpsMode): Promise<void> {
    // Stateless: sin sesión no hay stream GET ni DELETE que atender.
    if (req.method !== "POST") return reject(res, 405, { Allow: "POST" });
    const server = createNortexMcpServer({ api: o.api, tenant: o.tenant, mode: "ops", rateLimiter });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handleClient(
    req: IncomingMessage,
    res: ServerResponse,
    c: ClientMode,
    token: string,
  ): Promise<void> {
    const t = now();
    // F7.1: el token opaco no tiene claims; lo valida solo la sonda.
    const opaque = isOpaqueToken(token);
    // JWT: estructura/claims/kind/exp antes que nada: basura no llega ni a la sonda.
    const claims = opaque ? null : decodeClientClaims(token, t);
    if (!opaque && !claims) return unauthorized(res);
    const tokenHash = sha256(token);

    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string" && sid !== "") {
      const s = sessions.get(sid);
      if (!s) return jsonRpcError(res, 404, "Sesión no encontrada");
      // La sesión es del token (JWT u opaco) que la abrió: otro bearer → 401, sin revelar nada.
      if (!timingSafeEqual(s.tokenHash, tokenHash)) return unauthorized(res);
      if (sessionExpired(s, t)) {
        dropSession(sid);
        return unauthorized(res);
      }
      s.lastSeen = t;
      await s.transport.handleRequest(req, res);
      return;
    }

    // Sin sesión: solo POST initialize abre una.
    if (req.method !== "POST") return reject(res, 405, { Allow: "POST" });
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return jsonRpcError(res, 400, "JSON inválido");
    }
    if (!isInitialize(body)) return jsonRpcError(res, 400, "Falta Mcp-Session-Id: iniciá sesión con initialize");
    for (const [id, s] of sessions) if (sessionExpired(s, t)) dropSession(id);
    if (sessions.size >= maxSessions) return reject(res, 503, { "Retry-After": "60" });

    // UNA sonda con el token del cliente: el monolito decide si es válido.
    const api = c.apiForToken(token);
    try {
      await api.get(PROBE_PATH, { ...PROBE_QUERY });
    } catch (err) {
      if (err instanceof NortexAuthError) return unauthorized(res);
      console.error("[nortex-mcp] sonda de auth falló (fail closed):", err instanceof Error ? err.message : "error");
      return reject(res, 503, { "Retry-After": "30" });
    }

    const server = createNortexMcpServer(
      claims
        ? {
            api,
            tenant: claims.tenantId,
            userId: claims.userId,
            role: claims.role,
            mode: "client",
            authKind: "jwt",
            rateLimiter,
          }
        : // Opaca: el MCP no conoce tenant/usuario/rol; el monolito acota por el token.
          { api, tenant: null, mode: "client", authKind: "opaque", subject: opaqueSubject(token), rateLimiter },
    );
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, tokenHash, claims, lastSeen: t });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const app = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const path = (req.url ?? "").split("?")[0];
      if (path !== MCP_PATH) {
        // Ruta personal (MCP-CONNECT-01): el token de la URL es la credencial.
        const personal = personalTokenOfPath(path);
        if (personal === null || personal.includes("/")) return reject(res, 404);
        // Forma inválida → 401 sin sonda ni efectos (ni siquiera se toca la red).
        if (!isOpaqueTokenForm(personal)) return unauthorized(res);
        // Contradicción ruta/header: el tenant sale SOLO del token de la ruta.
        const headerBearer = bearerOf(req.headers.authorization);
        if (headerBearer !== null && headerBearer !== personal) return unauthorized(res);
        if (!client) return unauthorized(res);
        // Mismo camino que el Bearer por header: misma sonda, misma sesión.
        return await handleClient(req, res, client, personal);
      }
      // Auth primero: nada del protocolo se procesa sin token válido.
      if (ops && bearerMatches(req.headers.authorization, ops.token)) return await handleOps(req, res, ops);
      const bearer = bearerOf(req.headers.authorization);
      if (client && bearer) return await handleClient(req, res, client, bearer);
      return unauthorized(res);
    } catch (err) {
      console.error("[nortex-mcp] error HTTP:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) reject(res, 500);
      else res.end();
    }
  }) as HttpApp;

  app.clientSessionCount = () => sessions.size;
  const sweep = setInterval(() => {
    const t = now();
    for (const [id, s] of sessions) if (sessionExpired(s, t)) dropSession(id);
  }, 60_000);
  sweep.unref();
  app.on("close", () => {
    clearInterval(sweep);
    for (const id of [...sessions.keys()]) dropSession(id);
  });
  return app;
}

export function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address() as AddressInfo));
  });
}

export async function startHttpFromEnv(): Promise<Server> {
  const cfg = httpConfigFromEnv(); // lanza si no hay auth → main() sale con exit 1
  const clientApiUrl = cfg.clientApiUrl;
  const app = createHttpApp({
    ...(cfg.token ? { ops: { token: cfg.token, api: apiFromEnv(), tenant: tenantFromEnv() } } : {}),
    ...(clientApiUrl
      ? { client: { apiForToken: (token: string) => createHttpNortexApi({ baseUrl: clientApiUrl, token }) } }
      : {}),
    rateLimiter: new RateLimiter(rateLimitFromEnv()),
  });
  const addr = await listen(app, cfg.port, cfg.host);
  const modes = [cfg.token ? "ops" : null, clientApiUrl ? "cliente" : null].filter(Boolean).join(" + ");
  console.error(
    `[nortex-mcp] Streamable HTTP escuchando en http://${addr.address}:${addr.port}${MCP_PATH} (auth: ${modes})`,
  );
  return app;
}
