/**
 * Handlers de las tools (F1 + F2 + F5). Funciones puras testeables: reciben `ToolCtx`
 * (api inyectable + reloj) y devuelven el string en voseo listo para voz.
 *
 * Reglas de governance (vienen del ticket T4-03 y la skill nortex-mcp):
 * - El servidor ordena/presenta; el modelo narra. El modelo NUNCA hace aritmética.
 * - `ventas_hoy` ordena `products[]`/`daily[]` del reporte (el backend ya agrega).
 * - Sin IDs internos, sin JSON crudo, sin stack traces al usuario.
 * - Input inválido -> mensaje en voseo (la validación estricta vive acá, no solo
 *   en el schema declarado del MCP, para que el mensaje sea en voseo y no un
 *   error de protocolo).
 * - 401/403 -> fail closed: "No pude acceder a tu negocio, revisá tu sesión.",
 *   cero datos.
 */
import { z } from "zod";
import { NortexApi, NortexAuthError } from "./nortexApi.js";
import { fmtMoney, fmtQty, fmtVoiceMoney, joinList, pluralUnit } from "./fmtMoney.js";
import {
  daysBetweenManagua,
  isValidDateString,
  minusDaysManagua,
  weekdayNameManagua,
} from "./time.js";
import type {
  CatalogPage,
  CatalogProduct,
  LowStockProduct,
  ProductStock,
  ReportProductFull,
  SaleTransactionDetail,
  SalesReport,
  SalesReportFull,
  StockCountDetail,
  StockCountSummary,
} from "./types.js";

export interface ToolCtx {
  api: NortexApi;
  /** YYYY-MM-DD del día comercial America/Managua. Inyectable para tests. */
  today: () => string;
}

// ---- Mensajes (strings exactos, testeados) ----
export const MSG_SIN_VENTAS = "No hubo ventas hoy todavía.";
export const MSG_SIN_ACCESO = "No pude acceder a tu negocio, revisá tu sesión.";
export const MSG_ERROR_GENERICO = "Tuve un problema consultando tu negocio. Probá de nuevo en un rato.";
export const MSG_Q_MIN = "Decime qué buscar (mínimo 2 letras).";
export const MSG_PRODUCTO_MIN = "Decime el nombre del producto (mínimo 2 letras).";
export const MSG_LIMIT_MAX = "Pedí hasta 50 productos como máximo.";
export const MSG_LIMIT_MIN = "Pedí al menos 1 producto.";
export const MSG_DIAS_INVALIDO = "El período tiene que ser de 1 a 30 días.";
export const MSG_PERIODO_SIN_VENTAS = "No hubo ventas en ese período.";
export const MSG_STOCK_OK = "No tenés productos bajos de stock.";
export const MSG_UMBRAL_INVALIDO = "El umbral tiene que ser un número entero positivo.";
export const MSG_CONTEO_NINGUNO = "No tenés conteos abiertos.";
export const MSG_DETALLE_INVALIDO = "Decime la referencia de la factura (por ejemplo, A-15).";
export const detalleNoEncontrada = (ref: string) =>
  `No encontré la venta ${ref} en los últimos 31 días.`;
export const MSG_RATE_LIMIT = "Estás yendo muy rápido. Esperá un momento y probá de nuevo.";
export const MSG_INFORME_RANGO_MAX = "El informe cubre hasta 31 días. Pedime un rango más corto.";
export const MSG_INFORME_RANGO_INVALIDO = "Ese rango no es válido. Revisá las fechas y probá de nuevo.";
export const MSG_INFORME_PERIODO_INVALIDO = "Ese período no lo conozco. Pedime hoy, ayer, semana o mes.";
export const MSG_INFORME_TOP_INVALIDO = "Pedime entre 1 y 5 productos por ranking.";
export const nadaComo = (q: string) => `No encontré nada como '${q}'.`;
export const conteoNingunoEn = (bodega: string) => `No tenés conteos abiertos en '${bodega}'.`;

// ---- Schemas estrictos (validación de negocio, mensajes en voseo) ----
const BuscarArgs = z.object({
  q: z.string().trim().min(2),
  limit: z.number().int().min(1).max(50).default(10),
});

const StockArgs = z.object({
  producto: z.string().trim().min(2),
});

// ---- F2 ----
const PeriodoArgs = z.object({
  dias: z.number().int().min(1).max(30).default(7),
});

const BajoArgs = z.object({
  umbral: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const ConteoArgs = z.object({
  bodega: z.string().trim().max(80).optional(),
});

const PrecioArgs = z.object({
  producto: z.string().trim().min(2),
});

const DetalleArgs = z.object({
  factura: z.string().trim().min(1).max(24),
});

function buscarInvalido(issues: z.core.$ZodIssue[]): string {
  const issue = issues[0];
  if (issue && issue.path[0] === "limit") {
    return issue.code === "too_big" ? MSG_LIMIT_MAX : MSG_LIMIT_MIN;
  }
  return MSG_Q_MIN;
}

function apiErrorMessage(e: unknown): string {
  if (e instanceof NortexAuthError) return MSG_SIN_ACCESO;
  return MSG_ERROR_GENERICO;
}

function asList(page: CatalogPage | CatalogProduct[], limit: number): CatalogProduct[] {
  const items = Array.isArray(page) ? page : page.products ?? [];
  return items.slice(0, limit);
}

/**
 * ventas_hoy: total del día Managua + mejor producto (ordenando products[],
 * sin recalcular dinero).
 *
 * El titular es `grossSales` (lo cobrado, lo que entró a caja). El `netSales`
 * del bucket diario es (bruto − devoluciones) − IVA: para un negocio con IVA
 * incluido subestima lo vendido (defecto corregido el 2026-11-01: la tool
 * contestaba C$368.69 cuando la caja había cobrado C$424.00). Las
 * devoluciones, si las hubo, se nombran aparte con su propio agregado del
 * backend — nunca se restan acá.
 */
export async function ventasHoy(ctx: ToolCtx): Promise<string> {
  try {
    const report = await ctx.api.get<SalesReport>("/api/reports/sales");
    const entry = (report.daily ?? []).find((d) => d.date === ctx.today());
    if (!entry || entry.transactionCount === 0) return MSG_SIN_VENTAS;
    // Solo ordenar: el agregado lo hizo el backend. Comparar montos para ordenar
    // no es "hacer aritmética de dinero" (no se suma/resta nada).
    const ranked = [...(report.products ?? [])].sort(
      (a, b) => Number(b.grossSales ?? b.netSales) - Number(a.grossSales ?? a.netSales),
    );
    const best = ranked[0]?.productName;
    let text = `Hoy vendiste ${fmtMoney(entry.grossSales)} en ${entry.transactionCount} facturas.`;
    if (entry.returnCount > 0 && Number(entry.returnsTotal) > 0) {
      text += ` Tuviste devoluciones por ${fmtMoney(entry.returnsTotal)}.`;
    }
    if (best) text += ` Tu mejor producto fue ${best}.`;
    return text;
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/** buscar_producto: precio + stock por bodega de cada coincidencia (paginado, default 10, máx 50). */
export async function buscarProducto(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = BuscarArgs.safeParse(args ?? {});
  if (!parsed.success) return buscarInvalido(parsed.error.issues);
  const { q, limit } = parsed.data;
  try {
    const page = await ctx.api.get<CatalogPage | CatalogProduct[]>("/api/products", {
      search: q,
      page: 1,
      pageSize: limit,
    });
    const items = asList(page, limit);
    if (items.length === 0) return nadaComo(q);
    const lines: string[] = [];
    for (const p of items) {
      const stock = await ctx.api.get<ProductStock>(`/api/warehouses/product/${p.id}/stock`);
      const per = stock.warehouses.map((w) => `${fmtQty(w.stock)} en ${w.name}`);
      lines.push(`${p.name}: ${fmtMoney(p.price)} la ${p.unit}, te quedan ${joinList(per)}.`);
    }
    return lines.join("\n");
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/** stock_producto: stock total + por bodega de la primera coincidencia. */
export async function stockProducto(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = StockArgs.safeParse(args ?? {});
  if (!parsed.success) return MSG_PRODUCTO_MIN;
  const { producto } = parsed.data;
  try {
    const page = await ctx.api.get<CatalogPage | CatalogProduct[]>("/api/products", {
      search: producto,
      page: 1,
      pageSize: 5,
    });
    const items = asList(page, 5);
    if (items.length === 0) return nadaComo(producto);
    const p = items[0];
    const stock = await ctx.api.get<ProductStock>(`/api/warehouses/product/${p.id}/stock`);
    const total = fmtQty(stock.totalStock);
    const per = stock.warehouses.map((w) => `${fmtQty(w.stock)} en ${w.name}`).join(", ");
    return `Del ${p.name} te quedan ${total} ${pluralUnit(stock.unit, stock.totalStock)} en total: ${per}.`;
  } catch (e) {
    return apiErrorMessage(e);
  }
}

// ================= F2 =================

/**
 * ventas_periodo: total + mejor día de los últimos `dias` días civiles Managua.
 * El backend ya agrega `daily[]`; el MCP suma los agregados del período y ordena
 * para el "mejor día". El modelo nunca toca dinero.
 */
export async function ventasPeriodo(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = PeriodoArgs.safeParse(args ?? {});
  if (!parsed.success) return MSG_DIAS_INVALIDO;
  const { dias } = parsed.data;
  try {
    const end = ctx.today();
    const start = minusDaysManagua(end, dias - 1);
    const report = await ctx.api.get<SalesReport>("/api/reports/sales", {
      startDate: start,
      endDate: end,
    });
    const days = (report.daily ?? []).filter((d) => d.date >= start && d.date <= end);
    const totalTx = days.reduce((acc, d) => acc + d.transactionCount, 0);
    if (days.length === 0 || totalTx === 0) return MSG_PERIODO_SIN_VENTAS;
    // Suma en centavos (evita errores de float); el agregado base lo dio el backend.
    // Bruto (lo cobrado), como en ventas_hoy: el netSales diario descuenta el IVA.
    const cents = days.reduce((acc, d) => acc + Math.round(Number(d.grossSales) * 100), 0);
    const best = [...days].sort((a, b) => Number(b.grossSales) - Number(a.grossSales))[0];
    const periodo = dias === 1 ? "el último día" : `los últimos ${dias} días`;
    return (
      `En ${periodo} vendiste ${fmtMoney(cents / 100)} ` +
      `en ${totalTx} facturas. El mejor día fue el ${weekdayNameManagua(best.date)} ` +
      `con ${fmtMoney(best.grossSales)}.`
    );
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/**
 * inventario_bajo: productos con stock <= punto de reorden (o <= umbral).
 *
 * La llamada NO pide paginación a propósito (defecto corregido el
 * 2026-11-01): en el backend, la rama paginada de GET /api/products (la que
 * se activa cuando llega `page`) devuelve la página SIN aplicar el filtro
 * `lowStock` — la tool listaba todo el catálogo como si estuviera bajo. Sin
 * `page`, la rama simple sí filtra por `lowStock=true` y responde el arreglo
 * directo. `umbral` es un corte adicional de esta tool sobre ese resultado.
 */
export async function inventarioBajo(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = BajoArgs.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue && issue.path[0] === "umbral") return MSG_UMBRAL_INVALIDO;
    return issue && issue.code === "too_big" ? MSG_LIMIT_MAX : MSG_LIMIT_MIN;
  }
  const { umbral, limit } = parsed.data;
  try {
    const page = await ctx.api.get<CatalogPage | CatalogProduct[]>("/api/products", {
      lowStock: "true",
    });
    const rows = Array.isArray(page) ? page : page.products ?? [];
    let items = (rows as LowStockProduct[]).filter(
      (p) => Number.isFinite(Number(p.stock)) && Number.isFinite(Number(p.minStock)),
    );
    if (umbral !== undefined) items = items.filter((p) => Number(p.stock) <= umbral);
    items = items.slice(0, limit);
    if (items.length === 0) return MSG_STOCK_OK;
    const parts = items.map(
      (p) => `${p.name} (${fmtQty(p.stock)}, mínimo ${fmtQty(p.minStock)})`,
    );
    const n = items.length;
    return `Tenés ${n} ${n === 1 ? "producto bajo" : "productos bajos"}: ${joinList(parts)}.`;
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/**
 * estado_conteo: conteos con status OPEN/CLOSING de GET /api/stock-counts.
 * La lista real (verificada contra backend/server.ts, 2026-10-14) solo trae
 * `_count.items` (el total); el avance se calcula del detalle
 * GET /api/stock-counts/:id contando los ítems con `counted != null`
 * (StockCountItem.counted nullable, schema Prisma). Los conteos abiertos son
 * pocos por diseño del negocio, así que el detalle por conteo es aceptable.
 */
export async function estadoConteo(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = ConteoArgs.safeParse(args ?? {});
  if (!parsed.success) return MSG_ERROR_GENERICO;
  const { bodega } = parsed.data;
  try {
    const counts = await ctx.api.get<StockCountSummary[]>("/api/stock-counts");
    const open = (counts ?? []).filter((c) => c.status === "OPEN" || c.status === "CLOSING");
    const sel = bodega
      ? open.filter((c) => c.warehouse.name.toLowerCase() === bodega.toLowerCase())
      : open;
    if (sel.length === 0) return bodega ? conteoNingunoEn(bodega) : MSG_CONTEO_NINGUNO;
    const withProgress = await Promise.all(
      sel.map(async (c) => {
        const detail = await ctx.api.get<StockCountDetail>(`/api/stock-counts/${c.id}`);
        const items = detail.items ?? [];
        return {
          name: c.warehouse.name,
          countedItems: items.filter((i) => i.counted !== null && i.counted !== undefined).length,
          totalItems: items.length,
        };
      }),
    );
    if (withProgress.length === 1) {
      const c = withProgress[0];
      return (
        `Tenés un conteo abierto en ${c.name}: ` +
        `${c.countedItems} de ${c.totalItems} productos contados.`
      );
    }
    const parts = withProgress.map(
      (c) => `${c.name} (${c.countedItems} de ${c.totalItems} contados)`,
    );
    return `Tenés ${withProgress.length} conteos abiertos: ${joinList(parts)}.`;
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/**
 * precio_producto: atajo de precio (base NIO).
 * La extensión a USD vive en T6-10 (`precio_dolares`) — esta tool NO la duplica.
 */
export async function precioProducto(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = PrecioArgs.safeParse(args ?? {});
  if (!parsed.success) return MSG_PRODUCTO_MIN;
  const { producto } = parsed.data;
  try {
    const page = await ctx.api.get<CatalogPage | CatalogProduct[]>("/api/products", {
      search: producto,
      page: 1,
      pageSize: 5,
    });
    const items = asList(page, 5);
    if (items.length === 0) return nadaComo(producto);
    const p = items[0];
    return `El ${p.name} vale ${fmtMoney(p.price)} la ${p.unit}.`;
  } catch (e) {
    return apiErrorMessage(e);
  }
}

/** Parsea "A-15", "a15", "A 15" o "15" → { series?, number } (o null). */
function parseReferencia(raw: string): { series?: string; number: number } | null {
  const m = raw.trim().toUpperCase().match(/^([A-Z])?\s*-?\s*(\d{1,9})$/);
  if (!m) return null;
  return { series: m[1], number: Number(m[2]) };
}

const PAGO_TEXTO: Record<string, string> = {
  CASH: "Pagó en efectivo.",
  CARD: "Pagó con tarjeta.",
  TRANSFER: "Pagó por transferencia.",
  CREDIT: "Quedó a crédito.",
};

/**
 * detalle_venta — detalle real de una factura por su referencia (ej. A-15).
 *
 * Desde ACCESO-IA-DETALLE-01 el detalle sale de UN endpoint acotado del
 * backend, pensado para esta credencial: `GET
 * /api/reports/sales/transaction-detail?reference=A-15`. El backend
 * resuelve el tenant desde el token, busca en los últimos 31 días
 * (anuladas excluidas) y responde solo el total cobrado y las líneas del
 * snapshot — sin costos ni márgenes. La tool no suma ni resta: narra con
 * cantidad × precio unitario lo que el backend ya resolvió.
 *
 * Antes la tool componía `GET /api/reports/sales/transactions` + `GET
 * /api/sales/search`, ambas cerradas para MCP_READ (la segunda es la ruta
 * humana de devoluciones y sigue cerrada a propósito): en producción la
 * tool fallaba cerrada con MSG_SIN_ACCESO. 404 del endpoint = la venta no
 * está en la ventana (o no es de este negocio): mensaje honesto, cero
 * datos. 401/403 = fail closed como siempre.
 */
export async function detalleVenta(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = DetalleArgs.safeParse(args ?? {});
  if (!parsed.success) return MSG_DETALLE_INVALIDO;
  const ref = parseReferencia(parsed.data.factura);
  if (!ref) return MSG_DETALLE_INVALIDO;
  const refTexto = ref.series ? `${ref.series}-${ref.number}` : String(ref.number);
  try {
    const sale = await ctx.api.get<SaleTransactionDetail>(
      "/api/reports/sales/transaction-detail",
      { reference: refTexto },
    );
    let text = `La venta ${sale.reference} fue de ${fmtMoney(sale.total)}.`;
    const items = sale.items ?? [];
    if (items.length > 0) {
      const parts = items.map((i) => {
        const unit = (i.unit ?? "").trim();
        const head = unit
          ? `${fmtQty(i.quantity)} ${pluralUnit(unit, i.quantity)} de ${i.name}`
          : `${fmtQty(i.quantity)} de ${i.name}`;
        return `${head} a ${fmtMoney(i.priceAtSale)}`;
      });
      text += ` Llevaba: ${joinList(parts)}.`;
    }
    const cliente = sale.customerName;
    if (cliente && cliente !== "Consumidor Final") text += ` Cliente: ${cliente}.`;
    const pago = PAGO_TEXTO[String(sale.paymentMethod ?? "").toUpperCase()];
    if (pago) text += ` ${pago}`;
    return text;
  } catch (e) {
    if ((e as { status?: unknown })?.status === 404) return detalleNoEncontrada(refTexto);
    return apiErrorMessage(e);
  }
}

// ================= F5 =================

/**
 * informe_ventas — el «Reporte integral de ventas» A PEDIDO (ítem 7 del Plan
 * Nivel Odoo; lo que la clienta Andrea pidió por WhatsApp: reporte,
 * consolidado y qué es lo que más se vende).
 *
 * Composición: UNA sola llamada a `GET /api/reports/sales?startDate&endDate`,
 * el mismo endpoint que alimenta la pantalla de Reportes y el Excel de 5
 * hojas. Su respuesta YA trae summary (brutas/netas/IVA/utilidad/ticket
 * promedio), paymentMethods[] y products[] (cantidad neta, venta neta y
 * utilidad por producto) calculados por el backend con Decimal. La tool NO
 * suma ni resta dinero: solo ORDENA (los rankings) y FORMATEA.
 *
 * Diferencia deliberada contra la UI: la tabla «Productos vendidos» de la
 * pantalla sale en orden alfabético; acá los rankings salen ordenados de
 * mayor a menor (por cantidad neta y por utilidad), que es lo que el dueño
 * pregunta.
 *
 * Rango máximo 31 días: paridad con el documento/Excel del backend
 * (SALES_EXPORT_MAX_DAYS = 31 en backend/lib/salesReport.ts).
 *
 * Salida en dos bloques: (1) resumen hablado ≤ ~25 palabras (contrato de voz
 * T6 §4.1) y (2) bloque «Detalle del informe» en texto para pantalla/WhatsApp.
 * El tenant sale SOLO de la sesión (el cliente API lleva el token de la
 * sesión; la tool jamás envía tenantId) y 401/403 -> fail closed, cero datos.
 */
const InformeArgs = z.object({
  periodo: z.string().trim().toLowerCase().optional(),
  desde: z.string().trim().optional(),
  hasta: z.string().trim().optional(),
  top: z.number().int().min(1).max(5).default(3),
});

const INFORME_MAX_DIAS = 31;

type InformePeriodo = "hoy" | "ayer" | "semana" | "mes" | "rango";

const MESES_CORTOS = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
] as const;

/** "2026-09-16" -> "16 sep" (el año lo agrega el encabezado cuando hace falta). */
function fmtFechaCorta(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MESES_CORTOS[m - 1]}`;
}

function fmtFacturas(n: number): string {
  return `${n} ${n === 1 ? "factura" : "facturas"}`;
}

export async function informeVentas(ctx: ToolCtx, args: unknown): Promise<string> {
  const parsed = InformeArgs.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue && issue.path[0] === "top") return MSG_INFORME_TOP_INVALIDO;
    if (issue && (issue.path[0] === "desde" || issue.path[0] === "hasta")) {
      return MSG_INFORME_RANGO_INVALIDO;
    }
    return MSG_INFORME_PERIODO_INVALIDO;
  }
  const { periodo, desde, hasta, top } = parsed.data;
  const today = ctx.today();

  // ---- Resolver el rango (día civil America/Managua) ----
  let start: string;
  let end: string;
  let kind: InformePeriodo;
  let label: string;
  if (desde !== undefined || hasta !== undefined) {
    if (
      desde === undefined ||
      hasta === undefined ||
      !isValidDateString(desde) ||
      !isValidDateString(hasta) ||
      desde > hasta ||
      hasta > today
    ) {
      return MSG_INFORME_RANGO_INVALIDO;
    }
    if (daysBetweenManagua(desde, hasta) + 1 > INFORME_MAX_DIAS) {
      return MSG_INFORME_RANGO_MAX;
    }
    start = desde;
    end = hasta;
    kind = "rango";
    label = "En ese período";
  } else {
    const p = periodo ?? "mes";
    if (p !== "hoy" && p !== "ayer" && p !== "semana" && p !== "mes") {
      return MSG_INFORME_PERIODO_INVALIDO;
    }
    kind = p;
    if (p === "hoy") {
      start = end = today;
      label = "Hoy";
    } else if (p === "ayer") {
      start = end = minusDaysManagua(today, 1);
      label = "Ayer";
    } else if (p === "semana") {
      end = today;
      start = minusDaysManagua(today, 6);
      label = "En los últimos 7 días";
    } else {
      end = today;
      start = minusDaysManagua(today, 29);
      label = "En los últimos 30 días";
    }
  }
  const dias = daysBetweenManagua(start, end) + 1;

  try {
    const report = await ctx.api.get<SalesReportFull>("/api/reports/sales", {
      startDate: start,
      endDate: end,
    });
    const s = report.summary;
    // Sin summary no hay informe: jamás se fabrican cifras desde otra forma.
    if (!s || typeof s.transactionCount !== "number") return MSG_ERROR_GENERICO;
    if (s.transactionCount === 0) return MSG_PERIODO_SIN_VENTAS;

    const products = report.products ?? [];
    // Rankings ORDENADOS de verdad (la UI los muestra alfabéticos). Ordenar
    // no es calcular dinero: los montos vienen agregados por el backend.
    const porCantidad = [...products]
      .filter((p) => Number(p.quantityNet) > 0)
      .sort(
        (a, b) =>
          Number(b.quantityNet) - Number(a.quantityNet) ||
          Number(b.netSales) - Number(a.netSales) ||
          a.productName.localeCompare(b.productName),
      );
    const porUtilidad = [...products]
      .filter((p) => Number(p.grossProfit) > 0)
      .sort(
        (a, b) =>
          Number(b.grossProfit) - Number(a.grossProfit) ||
          Number(b.netSales) - Number(a.netSales) ||
          a.productName.localeCompare(b.productName),
      );
    const metodos = [...(report.paymentMethods ?? [])].sort(
      (a, b) =>
        Number(b.netSales) - Number(a.netSales) || a.label.localeCompare(b.label),
    );

    // ---- Bloque 1: resumen hablado (≤ ~25 palabras, contrato T6 §4.1) ----
    const utilidad = Number(s.grossProfit);
    const fraseUtilidad =
      utilidad >= 0
        ? `con utilidad bruta de ${fmtVoiceMoney(utilidad)}`
        : `con pérdida bruta de ${fmtVoiceMoney(Math.abs(utilidad))}`;
    let voz =
      `${label} vendiste ${fmtVoiceMoney(s.netSales)} en ${fmtFacturas(s.transactionCount)}, ` +
      `${fraseUtilidad}.`;
    const mejor = porCantidad[0];
    if (mejor) voz += ` Tu producto más vendido fue el ${mejor.productName}.`;

    // ---- Bloque 2: detalle en texto (pantalla / WhatsApp) ----
    const mismoAnio = start.slice(0, 4) === end.slice(0, 4);
    const rangoTxt =
      start === end
        ? `${fmtFechaCorta(start)} ${start.slice(0, 4)}`
        : mismoAnio
          ? `${fmtFechaCorta(start)} – ${fmtFechaCorta(end)} ${end.slice(0, 4)}`
          : `${fmtFechaCorta(start)} ${start.slice(0, 4)} – ${fmtFechaCorta(end)} ${end.slice(0, 4)}`;
    const lines: string[] = [
      `Detalle del informe · ${rangoTxt} · ${dias} ${dias === 1 ? "día" : "días"}:`,
      `Ventas brutas: ${fmtVoiceMoney(s.grossSales)}`,
    ];
    if (s.returnCount > 0 || Number(s.returnsTotal) !== 0) {
      lines.push(
        `Devoluciones: ${fmtVoiceMoney(s.returnsTotal)} en ${s.returnCount} ` +
          `${s.returnCount === 1 ? "devolución" : "devoluciones"}`,
      );
    }
    lines.push(
      `Ventas netas: ${fmtVoiceMoney(s.netSales)}`,
      `IVA recaudado: ${fmtVoiceMoney(s.vatCollected)}`,
      `Utilidad bruta: ${fmtVoiceMoney(s.grossProfit)}`,
      `Ticket promedio: ${fmtVoiceMoney(s.averageTicket)} · ${fmtFacturas(s.transactionCount)}`,
    );
    if (metodos.length > 0) {
      lines.push("", "Cómo te pagaron:");
      for (const m of metodos) {
        lines.push(
          `${m.label || m.method}: ${fmtVoiceMoney(m.netSales)} (${fmtFacturas(m.transactionCount)})`,
        );
      }
    }
    const filaCantidad = (p: ReportProductFull, i: number) => {
      const unidad = p.displayUnit ?? p.unit ?? "";
      const cant = unidad
        ? `${fmtQty(p.quantityNet)} ${pluralUnit(unidad, p.quantityNet)}`
        : fmtQty(p.quantityNet);
      return `${i + 1}. ${p.productName}: ${cant} · ${fmtVoiceMoney(p.netSales)} de venta neta`;
    };
    if (porCantidad.length > 0) {
      lines.push("", "Lo que más se vendió:");
      porCantidad.slice(0, top).forEach((p, i) => lines.push(filaCantidad(p, i)));
    }
    if (porUtilidad.length > 0) {
      lines.push("", "Lo que más utilidad dejó:");
      porUtilidad
        .slice(0, top)
        .forEach((p, i) => lines.push(`${i + 1}. ${p.productName}: ${fmtVoiceMoney(p.grossProfit)}`));
    }

    return `${voz}\n\n${lines.join("\n")}`;
  } catch (e) {
    return apiErrorMessage(e);
  }
}
