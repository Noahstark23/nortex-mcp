/**
 * Construcción del servidor MCP de Nortex, compartida por los transportes
 * stdio (index.ts) y Streamable HTTP (http.ts): MISMAS 10 tools, MISMA
 * governance (guarded: rate limit + auditoría, tenant fijado por el entorno
 * del servidor, nunca por el cliente).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHttpNortexApi, type NortexApi } from "./nortexApi.js";
import { createMockNortexApi } from "./mock.js";
import { todayManagua } from "./time.js";
import { RateLimiter } from "./rateLimit.js";
import { auditLog, type AuditStatus, type AuthKind, type SessionMode } from "./audit.js";
import {
  MSG_ERROR_GENERICO,
  MSG_RATE_LIMIT,
  buscarProducto,
  detalleVenta,
  estadoConteo,
  informeVentas,
  inventarioBajo,
  precioProducto,
  stockProducto,
  ventasHoy,
  ventasPeriodo,
  type ToolCtx,
} from "./tools.js";
import { resolverDuda } from "./resolverDuda.js";

export const SERVER_VERSION = "0.5.1";

export interface NortexServerDeps {
  /**
   * Backend de la sesión. Modo ops/stdio: el del entorno (service token).
   * Modo cliente (F7): uno POR SESIÓN, construido con el JWT del cliente; el
   * monolito re-valida ese JWT en cada llamada y acota al tenant del token.
   */
  api: NortexApi;
  /**
   * Tenant de la sesión: NORTEX_TENANT_ID (ops/stdio) o claim del JWT (cliente).
   * null en sesiones opacas (F7.1): el monolito acota cada llamada por el token.
   */
  tenant: string | null;
  /** Usuario de la sesión (solo modo cliente JWT: claim `userId`). */
  userId?: string;
  /** Rol de la sesión (solo modo cliente JWT: claim `role`). */
  role?: string;
  /** Modo de la sesión, para auditoría. Default "ops". */
  mode?: SessionMode;
  /** Solo modo cliente: credencial con la que se abrió la sesión, para auditoría. */
  authKind?: AuthKind;
  /**
   * Identidad de rate limit y auditoría cuando no hay tenant/usuario
   * (sesión opaca: `opaque:<sha256 hex del token>`). Nunca el token.
   */
  subject?: string;
  /** Compartido entre servidores: en HTTP stateless se crea un servidor por request. */
  rateLimiter: RateLimiter;
}

/**
 * Clave de rate limit: por tenant en ops/stdio (un tenant por proceso, como
 * siempre); por tenant+usuario en modo cliente (cada persona su cubeta).
 */
export function rateLimitKey(deps: Pick<NortexServerDeps, "tenant" | "userId" | "subject">): string {
  if (deps.subject) return deps.subject; // sesión opaca: por hash del token
  if (deps.tenant === null) throw new Error("rateLimitKey: sesión sin tenant ni subject (fail closed)");
  return deps.userId ? `${deps.tenant}:${deps.userId}` : deps.tenant;
}

/** Elige mock|http según el entorno; sale con error claro si falta config. */
export function apiFromEnv(): NortexApi {
  const mode = (process.env.NORTEX_API_MODE ?? "mock").toLowerCase();
  if (mode === "http") {
    const baseUrl = process.env.NORTEX_API_URL;
    const token = process.env.NORTEX_SERVICE_TOKEN; // solo vía env
    if (!baseUrl || !token) {
      throw new Error(
        "NORTEX_API_MODE=http requiere NORTEX_API_URL y NORTEX_SERVICE_TOKEN en el entorno.",
      );
    }
    return createHttpNortexApi({ baseUrl, token });
  }
  if (mode !== "mock") console.error(`[nortex-mcp] modo "${mode}" desconocido, uso mock.`);
  return createMockNortexApi();
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Envuelve cada tool con rate limit + auditoría.
 * Los handlers ya devuelven mensajes en voseo ante cualquier error; el catch
 * acá es solo red de seguridad (nunca debe dispararse).
 */
function guarded(
  server: McpServer,
  deps: NortexServerDeps,
  name: string,
  description: string,
  shape: Record<string, z.ZodTypeAny>,
  run: (args: unknown) => Promise<string>,
): void {
  server.tool(name, description, shape, async (args: unknown) => {
    const start = Date.now();
    // Solo ids/hash: ni el JWT ni el token opaco llegan NUNCA a la auditoría.
    const audit = (status: AuditStatus) =>
      auditLog({
        tool: name,
        tenant: deps.tenant,
        ...(deps.userId !== undefined ? { userId: deps.userId } : {}),
        ...(deps.role !== undefined ? { role: deps.role } : {}),
        mode: deps.mode ?? "ops",
        ...(deps.authKind !== undefined ? { authKind: deps.authKind } : {}),
        ...(deps.subject !== undefined ? { subject: deps.subject } : {}),
        ts: new Date().toISOString(),
        latencyMs: Date.now() - start,
        status,
      });
    if (!deps.rateLimiter.allow(rateLimitKey(deps))) {
      audit("rate_limited");
      return textResult(MSG_RATE_LIMIT);
    }
    try {
      const text = await run(args);
      audit("ok");
      return textResult(text);
    } catch {
      audit("error");
      return textResult(MSG_ERROR_GENERICO);
    }
  });
}

export function createNortexMcpServer(deps: NortexServerDeps): McpServer {
  rateLimitKey(deps); // fail closed al construir: toda sesión tiene identidad de rate limit
  const { api } = deps;
  const ctx: ToolCtx = { api, today: todayManagua };
  const server = new McpServer({ name: "nortex-mcp", version: SERVER_VERSION });

  const register = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny>,
    run: (args: unknown) => Promise<string>,
  ) => guarded(server, deps, name, description, shape, run);

  // ---- F1 ----
  register(
    "ventas_hoy",
    "Cuánto vendió el negocio hoy (día comercial America/Managua), en voseo listo para voz.",
    {},
    () => ventasHoy(ctx),
  );

  register(
    "buscar_producto",
    "Busca productos por nombre. Devuelve precio y stock por bodega, en voseo.",
    {
      q: z.string().describe("Texto a buscar (mínimo 2 letras)"),
      limit: z.number().int().optional().describe("Cuántos mostrar; default 10, máximo 50"),
    },
    (args) => buscarProducto(ctx, args),
  );

  register(
    "stock_producto",
    "Cuánto stock queda de un producto, total y por bodega, en voseo.",
    {
      producto: z.string().describe("Nombre del producto (mínimo 2 letras)"),
    },
    (args) => stockProducto(ctx, args),
  );

  // ---- F2 ----
  register(
    "ventas_periodo",
    "Ventas de los últimos N días (1-30, default 7) con el mejor día, en voseo.",
    {
      dias: z.number().int().optional().describe("Período en días: 1 a 30, default 7"),
    },
    (args) => ventasPeriodo(ctx, args),
  );

  register(
    "inventario_bajo",
    "Productos con stock bajo (punto de reorden o umbral dado), en voseo.",
    {
      umbral: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Avisar si quedan N o menos; default: punto de reorden del producto"),
      limit: z.number().int().optional().describe("Cuántos mostrar; default 10, máximo 50"),
    },
    (args) => inventarioBajo(ctx, args),
  );

  register(
    "estado_conteo",
    "Conteos de inventario abiertos (qué bodega, cuánto llevan contado), en voseo.",
    {
      bodega: z.string().optional().describe("Nombre de la bodega; default: todas"),
    },
    (args) => estadoConteo(ctx, args),
  );

  register(
    "precio_producto",
    "Precio base (NIO) de un producto, en voseo. El precio en USD vive en T6 (precio_dolares).",
    {
      producto: z.string().describe("Nombre del producto (mínimo 2 letras)"),
    },
    (args) => precioProducto(ctx, args),
  );

  register(
    "detalle_venta",
    "Detalle de una factura por su referencia (ej. A-15): total, líneas con cantidades y precios, cliente y cómo pagó. Busca en los últimos 31 días.",
    {
      factura: z.string().describe("Referencia de la factura, ej. A-15"),
    },
    (args) => detalleVenta(ctx, args),
  );

  // ---- F5 ----
  register(
    "informe_ventas",
    "Informe integral de ventas a pedido: consolidado del período (ventas brutas/netas, IVA, utilidad bruta, ticket promedio), cómo pagaron y los productos que más se venden y más utilidad dejan, ordenados. Resumen en voseo listo para voz + detalle en texto.",
    {
      periodo: z
        .enum(["hoy", "ayer", "semana", "mes"])
        .optional()
        .describe("Período rápido; default: mes (últimos 30 días). semana = últimos 7 días"),
      desde: z
        .string()
        .optional()
        .describe("Fecha inicial YYYY-MM-DD (rango personalizado, con `hasta`; máximo 31 días)"),
      hasta: z
        .string()
        .optional()
        .describe("Fecha final YYYY-MM-DD (rango personalizado, con `desde`; máximo 31 días)"),
      top: z
        .number()
        .int()
        .optional()
        .describe("Cuántos productos por ranking; default 3, máximo 5"),
    },
    (args) => informeVentas(ctx, args),
  );

  // ---- F6 ----
  register(
    "resolver_duda",
    "Responde dudas de USO de Nortex (cómo se hace algo en la app: vender por caja, códigos de barras, regalías, lotes, anulaciones, etc.) con fuentes oficiales: el Manual de Usuario y casos verificados contra el código. Devuelve respuesta breve en voseo + fuente + confianza; si ninguna fuente respalda, dice explícitamente 'Sin fundamento en el manual'. Solo conocimiento: no lee ni toca datos del negocio.",
    {
      pregunta: z.string().describe("La duda de la persona, en sus palabras (5 a 500 letras)"),
    },
    async (args) => resolverDuda(args),
  );

  return server;
}
