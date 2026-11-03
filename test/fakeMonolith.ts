/**
 * Monolito Nortex FALSO para los tests de F7 (auth por cliente).
 *
 * Imita lo que importa del real (backend/middleware/auth.ts + services/secrets.ts,
 * origin/main 2026-10-16): JWT HS256 con secreto que el MCP NO conoce, payload
 * {userId, tenantId, role}, tokens con `kind` rechazados, re-validación en CADA
 * request (usuario revocado → 403), token inválido/vencido → 403, y los datos
 * acotados al tenant DEL TOKEN (no hay forma de pedir otro tenant).
 * Cada tenant sirve sus datos desde su propio NortexApi.
 *
 * F7.1: también acepta tokens opacos `nxt_` (backend/services/mcpAccessTokens.ts,
 * commit ae6a48d): se buscan por SHA-256 en una tabla propia del monolito, el
 * principal (tenant/usuario) sale de esa fila — nunca del token —, un token
 * desconocido o revocado → 401 MCP_TOKEN_INVALID, y cualquier método no-GET → 403.
 */
import { createServer, type Server } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NortexApi } from "../src/nortexApi.js";
import type { CatalogPage, ProductStock, SalesReport, StockCountSummary } from "../src/types.js";

export const FAKE_SECRET = "secreto-del-monolito-que-el-mcp-no-tiene";

export function signJwt(payload: Record<string, unknown>, secret = FAKE_SECRET, ttlSec = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iat: now, exp: now + ttlSec, ...payload })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** Token opaco con la forma real del monolito: `nxt_` + 32 bytes base64url. */
export function makeOpaqueToken(): string {
  return "nxt_" + randomBytes(32).toString("base64url");
}

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function verify(token: string): Record<string, unknown> | null {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const expected = createHmac("sha256", FAKE_SECRET).update(`${h}.${p}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims.kind !== undefined) return null;
  if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export interface MonolithCall {
  tenantId: string;
  userId: string;
  authKind: "jwt" | "opaque";
  path: string;
  query: Record<string, string>;
}

export interface FakeMonolith {
  url: string;
  calls: MonolithCall[];
  /** Usuarios deshabilitados: el próximo request con su JWT da 403 (re-validación por request). */
  revoked: Set<string>;
  /** Si true, todo responde 500 (monolito caído). */
  down: { value: boolean };
  /** Emite un token opaco para tenant/usuario (el monolito guarda SOLO su hash). */
  issueOpaque(tenantId: string, userId: string): string;
  /** Revoca un token opaco: el próximo request con él da 401. */
  revokeOpaque(token: string): void;
  close(): Promise<void>;
}

export async function startFakeMonolith(tenants: Record<string, NortexApi>): Promise<FakeMonolith> {
  const calls: MonolithCall[] = [];
  const revoked = new Set<string>();
  const down = { value: false };
  const opaque = new Map<string, { tenantId: string; userId: string; revoked: boolean }>(); // por SHA-256 hex
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (down.value) return send(500, { error: "caído" });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return send(401, { error: "Acceso Denegado: No se proporcionó token." });
    const bearer = auth.slice(7);
    let tenantId: string;
    let userId: string;
    let authKind: MonolithCall["authKind"];
    if (bearer.startsWith("nxt_")) {
      const row = /^nxt_[A-Za-z0-9_-]{43}$/.test(bearer) ? opaque.get(sha256hex(bearer)) : undefined;
      if (!row || row.revoked) {
        return send(401, {
          error: "Acceso Denegado: El token de acceso para IA no es válido o fue revocado.",
          code: "MCP_TOKEN_INVALID",
        });
      }
      if (req.method !== "GET") return send(403, { error: "Solo lectura", code: "MCP_READ_ONLY" });
      ({ tenantId, userId } = row);
      authKind = "opaque";
    } else {
      const claims = verify(bearer);
      if (!claims) return send(403, { error: "Acceso Denegado: Token inválido o expirado." });
      tenantId = String(claims.tenantId);
      userId = String(claims.userId);
      authKind = "jwt";
    }
    if (revoked.has(userId)) return send(403, { error: "Acceso Denegado: La sesion ya no esta activa." });
    const api = tenants[tenantId];
    if (!api) return send(403, { error: "Acceso Denegado: La sesion ya no esta activa." });
    const u = new URL(req.url ?? "/", "http://x");
    const query = Object.fromEntries(u.searchParams);
    calls.push({ tenantId, userId, authKind, path: u.pathname, query });
    try {
      send(200, await api.get(u.pathname, query));
    } catch (e) {
      send((e as { status?: number }).status === 404 ? 404 : 500, { error: "x" });
    }
  });
  const addr = await new Promise<AddressInfo>((r) =>
    server.listen(0, "127.0.0.1", () => r(server.address() as AddressInfo)),
  );
  return {
    url: `http://127.0.0.1:${addr.port}`,
    calls,
    revoked,
    down,
    issueOpaque(tenantId, userId) {
      const token = makeOpaqueToken();
      opaque.set(sha256hex(token), { tenantId, userId, revoked: false });
      return token;
    },
    revokeOpaque(token) {
      const row = opaque.get(sha256hex(token));
      if (row) row.revoked = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Tenant B: una ferretería (datos que el tenant A jamás debe ver). */
export function createFerreteriaApi(): NortexApi {
  const products = [{ id: "b-tornillo", name: "Tornillo de 3/8", price: 7.5, unit: "unidad" }];
  return {
    async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
      if (path === "/api/products") {
        const q = String(query.search ?? "").toLowerCase();
        const matched = products.filter((p) => p.name.toLowerCase().includes(q));
        const page: CatalogPage = { products: matched, total: matched.length, page: 1, pageSize: 10 };
        return page as T;
      }
      if (path === "/api/warehouses/product/b-tornillo/stock") {
        const s: ProductStock = {
          productId: "b-tornillo",
          totalStock: "900.0000",
          unit: "unidad",
          warehouses: [
            { id: "b-w1", name: "Bodega Ferretera", isDefault: true, isActive: true, stock: "900.0000", implicit: false },
          ],
          hasMore: false,
        };
        return s as T;
      }
      if (path === "/api/reports/sales") return { products: [], daily: [] } satisfies SalesReport as T;
      if (path === "/api/stock-counts") return [] satisfies StockCountSummary[] as T;
      throw Object.assign(new Error("404"), { status: 404 });
    },
  };
}
