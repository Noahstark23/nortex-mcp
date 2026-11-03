/**
 * Mock de NortexApi para F1+F2.
 *
 * ⚠️ DATOS SINTÉTICOS, pero con FORMAS verificadas contra el código del
 * monolito el 2026-10-14 (rutas, parámetros y shapes de respuesta leídos en
 * nortex.20). La paridad contra staging vivo sigue siendo F3 (requiere JWT
 * de staging, bloqueado — paso de cuenta de Noel).
 *
 * Hallazgos del borrador que se respetan:
 * - Stock de producto: `/api/warehouses/product/:productId/stock`
 *   (backend/routes/warehouses.ts:27). La ruta `/:id/product/:productId/stock` NO existe.
 * - `GET /api/reports/sales` trae `products[]` y `daily[]` ya agregados: el mock
 *   los devuelve DESORDENADOS a propósito para probar que el servidor ordena
 *   (el servidor nunca recalcula dinero).
 * - `GET /api/sales/document` devuelve HTML y NO se usa. `detalle_venta`
 *   consume el endpoint acotado `GET
 *   /api/reports/sales/transaction-detail?reference=A-15`
 *   (ACCESO-IA-DETALLE-01); las rutas viejas (transactions + sales/search)
 *   quedan en el mock solo como superficie heredada, ya sin consumidor.
 * - `GET /api/products`: la rama PAGINADA del backend (con `page`) ignora el
 *   filtro `lowStock` — el mock la emula tal cual; la rama simple (sin
 *   `page`) sí filtra y responde el arreglo directo. `inventario_bajo` usa
 *   la rama simple a propósito.
 * - `GET /api/stock-counts` devuelve conteos con status OPEN/CLOSING primero
 *   (decisión F0: entra en v1).
 * - Dinero del reporte como strings; precio del catálogo como número (Float);
 *   stock del snapshot como strings toFixed(4); stock/minStock del catálogo
 *   como números (Float).
 */
import { NortexApi, NortexAuthError } from "./nortexApi.js";
import { minusDaysManagua, todayManagua } from "./time.js";
import type {
  CatalogPage,
  CatalogProduct,
  LowStockProduct,
  ProductStock,
  ReportDaily,
  SalesReport,
  StockCountDetail,
  StockCountSummary,
} from "./types.js";

export type MockMode = "ok" | "unauthorized";

export interface MockOpts {
  mode?: MockMode;
  /** YYYY-MM-DD civil Managua que ancla la serie de ventas (default: hoy real). */
  anchorDate?: string;
}

const WAREHOUSES = [
  { id: "w-principal", name: "Principal", isDefault: true, isActive: true },
  { id: "w-sucursal", name: "Sucursal", isDefault: false, isActive: true },
] as const;

interface MockProduct extends CatalogProduct {
  stockByWarehouse: Record<string, string>; // warehouseId -> "15.0000"
  minStock: number; // punto de reorden (Float del backend)
}

const PRODUCTS: MockProduct[] = [
  {
    id: "p-queso-frito",
    name: "Queso frito",
    price: 120.0,
    unit: "libra",
    minStock: 10,
    stockByWarehouse: { "w-principal": "15.0000", "w-sucursal": "4.0000" },
  },
  {
    id: "p-queso-fresco",
    name: "Queso fresco",
    price: 100.0,
    unit: "libra",
    minStock: 12,
    stockByWarehouse: { "w-principal": "8.0000" },
  },
  {
    id: "p-queso-seco",
    name: "Queso seco",
    price: 95.0,
    unit: "libra",
    minStock: 10,
    stockByWarehouse: { "w-principal": "12.0000", "w-sucursal": "3.0000" },
  },
  {
    id: "p-leche",
    name: "Leche",
    price: 30.0,
    unit: "litro",
    minStock: 12,
    stockByWarehouse: { "w-principal": "6.0000" },
  },
];

function totalStockOf(p: MockProduct): number {
  return Object.values(p.stockByWarehouse).reduce((acc, s) => acc + Number(s), 0);
}

/**
 * Serie determinista de 30 días (sintética). El día del ancla conserva los
 * valores canónicos de F1 (C$12,450.00, 38 facturas) para no romper sus tests.
 */
function dailySeries(anchorDate: string): ReportDaily[] {
  const out: ReportDaily[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = minusDaysManagua(anchorDate, i);
    // La serie canónica es el BRUTO cobrado (grossSales). El netSales del
    // bucket diario, como en el backend real, es (bruto − devoluciones) −
    // IVA: sin devoluciones, bruto × 100/115.
    const gross = i === 0 ? 12450 : 8500 + ((i * 7919) % 7000);
    out.push({
      date,
      grossSales: `${gross}.00`,
      returnsTotal: "0.00",
      returnCount: 0,
      netSales: (Math.round((gross * 10000) / 115) / 100).toFixed(2),
      transactionCount: i === 0 ? 38 : 25 + ((i * 613) % 20),
    });
  }
  return out;
}

function salesReport(anchorDate: string, query: Record<string, string | number> = {}): SalesReport {
  const daily = dailySeries(anchorDate);
  // Forma COMPLETA del «Reporte integral» (summary/paymentMethods/products con
  // utilidad), como la devuelve el backend real (backend/lib/salesReport.ts).
  // Los agregados se derivan de la serie diaria del rango pedido con
  // proporciones fijas y declaradas (datos sintéticos): sin devoluciones,
  // IVA = 15/115 del bruto, costo = 70% del ingreso sin IVA.
  const startQ = typeof query.startDate === "string" ? query.startDate : undefined;
  const endQ = typeof query.endDate === "string" ? query.endDate : undefined;
  const inRange = daily.filter(
    (d) => (startQ === undefined || d.date >= startQ) && (endQ === undefined || d.date <= endQ),
  );
  const cents = (v: string) => Math.round(Number(v) * 100);
  const money = (c: number) => (c / 100).toFixed(2);
  const netC = inRange.reduce((acc, d) => acc + cents(d.grossSales), 0);
  const tx = inRange.reduce((acc, d) => acc + d.transactionCount, 0);
  const vatC = Math.round((netC * 15) / 115);
  const revenueC = netC - vatC;
  const cogsC = Math.round(revenueC * 0.7);
  const efTx = Math.round(tx * 0.6);
  const efC = Math.round(netC * 0.6);
  return {
    // products[] DESORDENADO a propósito: el handler debe ordenar por netSales.
    products: [
      { productId: "p-queso-seco", productName: "Queso seco", netSales: "2100.00", quantityNet: "22.0000" },
      { productId: "p-queso-frito", productName: "Queso frito", netSales: "8500.00", quantityNet: "70.8333" },
      { productId: "p-queso-fresco", productName: "Queso fresco", netSales: "1850.00", quantityNet: "18.5000" },
    ].map((p) => ({
      ...p,
      grossSales: p.netSales,
      quantitySold: p.quantityNet,
      quantityReturned: "0.0000",
      grossProfit: money(Math.round(cents(p.netSales) * 0.3)),
      unit: "libra",
      displayUnit: "libra",
    })),
    daily,
    business: { name: "Pulpería La Demo", taxId: "0010000000001" },
    period: {
      startDate: startQ ?? daily[0].date,
      endDate: endQ ?? daily[daily.length - 1].date,
      days: inRange.length,
    },
    summary: {
      grossSales: money(netC),
      returnsTotal: "0.00",
      netSales: money(netC),
      vatCollected: money(vatC),
      netRevenue: money(revenueC),
      cogs: money(cogsC),
      grossProfit: money(revenueC - cogsC),
      transactionCount: tx,
      returnCount: 0,
      averageTicket: tx > 0 ? money(Math.round(netC / tx)) : "0.00",
      discountTotal: "0.00",
    },
    paymentMethods: [
      {
        method: "CASH",
        label: "Efectivo",
        transactionCount: efTx,
        returnCount: 0,
        grossSales: money(efC),
        returnsTotal: "0.00",
        netSales: money(efC),
      },
      {
        method: "TRANSFER",
        label: "Transferencia",
        transactionCount: tx - efTx,
        returnCount: 0,
        grossSales: money(netC - efC),
        returnsTotal: "0.00",
        netSales: money(netC - efC),
      },
    ],
  } as SalesReport;
}

function toCatalogRow(p: MockProduct, lowStockMode: boolean): CatalogProduct | LowStockProduct {
  const { stockByWarehouse: _s, ...base } = p;
  if (!lowStockMode) return base;
  return { ...base, stock: totalStockOf(p), minStock: p.minStock };
}

function catalogPage(
  search: string,
  page: number,
  pageSize: number,
  lowStockMode: boolean,
): CatalogPage {
  const q = search.trim().toLowerCase();
  const matched = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q));
  const start = (page - 1) * pageSize;
  return {
    products: matched
      .slice(start, start + pageSize)
      .map((p) => toCatalogRow(p, lowStockMode)),
    total: matched.length,
    page,
    pageSize,
  };
}

function productStock(productId: string): ProductStock {
  const p = PRODUCTS.find((x) => x.id === productId);
  if (!p) throw new NortexApiError404();
  const warehouses = WAREHOUSES.filter((w) => p.stockByWarehouse[w.id] !== undefined).map(
    (w) => ({
      id: w.id,
      name: w.name,
      isDefault: w.isDefault,
      isActive: w.isActive,
      stock: p.stockByWarehouse[w.id],
      implicit: false,
    }),
  );
  const total = warehouses.reduce((acc, w) => acc + Number(w.stock), 0);
  return {
    productId: p.id,
    totalStock: total.toFixed(4),
    unit: p.unit,
    warehouses,
    hasMore: false,
  };
}

/**
 * Conteos sintéticos: 2 abiertos (OPEN/CLOSING) + 1 cerrado (se filtra).
 * Forma de LISTA verificada contra backend/server.ts (2026-10-14): filas con
 * `_count: { items }` (solo el total). El avance vive en el DETALLE
 * (/api/stock-counts/:id -> { count, items[] con counted nullable }):
 * sc-1 = 120 de 200 contados, sc-2 = 30 de 50, sc-3 = 200 de 200 (cerrado).
 */
const COUNT_PROGRESS: Record<string, { total: number; counted: number }> = {
  "sc-1": { total: 200, counted: 120 },
  "sc-2": { total: 50, counted: 30 },
  "sc-3": { total: 200, counted: 200 },
};

function stockCounts(): StockCountSummary[] {
  const base = [
    { id: "sc-1", status: "OPEN" as const, warehouse: { id: "w-principal", name: "Principal" } },
    { id: "sc-2", status: "CLOSING" as const, warehouse: { id: "w-sucursal", name: "Sucursal" } },
    { id: "sc-3", status: "CLOSED" as const, warehouse: { id: "w-principal", name: "Principal" } },
  ];
  return base.map((c) => ({
    ...c,
    creator: { name: "María" },
    _count: { items: COUNT_PROGRESS[c.id].total },
  }));
}

function stockCountDetail(id: string): StockCountDetail & { count: StockCountSummary } {
  const spec = COUNT_PROGRESS[id];
  const summary = stockCounts().find((c) => c.id === id);
  if (!spec || !summary) throw new NortexApiError404();
  return {
    count: summary,
    items: Array.from({ length: spec.total }, (_, i) => ({
      counted: i < spec.counted ? 1 : null,
    })),
  };
}
/**
 * Ventas sintéticas para `detalle_venta`: dos facturas de la serie A
 * (la del ancla y la del día anterior), con líneas coherentes con su total.
 */
function mockTransactions(anchor: string) {
  return [
    {
      id: "sale-a-001234",
      invoiceSeries: "A",
      invoiceNumber: 1234,
      date: anchor,
      customerName: "Consumidor Final",
      paymentMethod: "CASH",
      total: "1240.00",
      items: [
        { productNameAtSale: "Queso frito", quantity: "8.0000", priceAtSale: "120.00", unitAtSale: "libra" },
        { productNameAtSale: "Queso fresco", quantity: "2.8000", priceAtSale: "100.00", unitAtSale: "libra" },
      ],
    },
    {
      id: "sale-a-001233",
      invoiceSeries: "A",
      invoiceNumber: 1233,
      date: minusDaysManagua(anchor, 1),
      customerName: "Consumidor Final",
      paymentMethod: "TRANSFER",
      total: "300.00",
      items: [
        { productNameAtSale: "Leche", quantity: "10.0000", priceAtSale: "30.00", unitAtSale: "litro" },
      ],
    },
  ];
}

function transactionsPage(anchor: string, query: Record<string, string | number>) {
  const start = typeof query.startDate === "string" ? query.startDate : undefined;
  const end = typeof query.endDate === "string" ? query.endDate : undefined;
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 50);
  const rows = mockTransactions(anchor)
    .filter((t) => (start === undefined || t.date >= start) && (end === undefined || t.date <= end))
    .map((t) => ({
      id: t.id,
      invoiceNumber: t.invoiceNumber,
      invoiceSeries: t.invoiceSeries,
      createdAt: `${t.date}T15:04:00.000Z`,
      customerName: t.customerName,
      paymentMethod: t.paymentMethod,
      total: t.total,
      status: "COMPLETED",
    }));
  const from = (page - 1) * pageSize;
  return {
    items: rows.slice(from, from + pageSize),
    total: rows.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(rows.length / pageSize)),
  };
}

/**
 * ACCESO-IA-DETALLE-01: el endpoint acotado que consume `detalle_venta`.
 * Misma gramática de referencia y misma ventana (31 días) que el backend
 * real; sin coincidencia (u otra serie) -> 404 interno, cero datos.
 */
function transactionDetail(anchor: string, query: Record<string, string | number>) {
  const raw = String(query.reference ?? "").trim().toUpperCase();
  const m = raw.match(/^([A-Z])?\s*-?\s*(\d{1,9})$/);
  if (!m) throw new NortexApiError404();
  const series = m[1];
  const number = Number(m[2]);
  const t = mockTransactions(anchor).find(
    (x) =>
      x.invoiceNumber === number &&
      (series === undefined || x.invoiceSeries === series) &&
      x.date >= minusDaysManagua(anchor, 31),
  );
  if (!t) throw new NortexApiError404();
  return {
    reference: `${t.invoiceSeries}-${t.invoiceNumber}`,
    date: `${t.date}T15:04:00.000Z`,
    total: t.total,
    customerName: t.customerName,
    paymentMethod: t.paymentMethod,
    status: "COMPLETED",
    items: t.items.map((i) => ({
      name: i.productNameAtSale,
      quantity: Number(i.quantity),
      unit: i.unitAtSale,
      priceAtSale: i.priceAtSale,
    })),
  };
}

function saleSearch(anchor: string, q: string) {
  const t = mockTransactions(anchor).find((x) => q.length > 0 && x.id.startsWith(q));
  if (!t) throw new NortexApiError404();
  return {
    id: t.id,
    invoiceNumber: t.invoiceNumber,
    invoiceSeries: t.invoiceSeries,
    total: t.total,
    paymentMethod: t.paymentMethod,
    customer: null,
    items: t.items,
  };
}

/** 404 interno del mock (producto inexistente). No se expone al usuario. */
class NortexApiError404 extends Error {
  readonly status = 404;
  constructor() {
    super("nortex mock: producto no encontrado");
    this.name = "NortexApiError404";
  }
}

export function createMockNortexApi(opts: MockOpts = {}): NortexApi {
  const mode = opts.mode ?? "ok";
  const anchor = opts.anchorDate ?? todayManagua();
  return {
    async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
      // Token ajeno / revocado / ausente -> fail closed, cero datos.
      if (mode === "unauthorized") throw new NortexAuthError();

      if (path === "/api/reports/sales") {
        return salesReport(anchor, query) as T;
      }
      if (path === "/api/products") {
        const lowStock = String(query.lowStock ?? "") === "true";
        const search = String(query.search ?? "");
        if (query.page === undefined) {
          // Rama simple del backend real: filtra lowStock en memoria y
          // responde el ARREGLO directo (sin envoltorio de página).
          const q = search.trim().toLowerCase();
          const matched = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q)).filter(
            (p) => !lowStock || totalStockOf(p) <= p.minStock,
          );
          return matched.map((p) => toCatalogRow(p, true)) as T;
        }
        // Rama paginada: el backend real NO aplica el filtro lowStock acá
        // (catalogPage ya no filtra por stock bajo; solo da forma a las filas).
        const page = Number(query.page ?? 1);
        const pageSize = Number(query.pageSize ?? 10);
        return catalogPage(search, page, pageSize, false) as T;
      }
      if (path === "/api/reports/sales/transaction-detail") {
        return transactionDetail(anchor, query) as T;
      }
      if (path === "/api/reports/sales/transactions") {
        return transactionsPage(anchor, query) as T;
      }
      if (path === "/api/sales/search") {
        return saleSearch(anchor, String(query.q ?? "")) as T;
      }
      if (path === "/api/stock-counts") {
        return stockCounts() as T;
      }
      const mc = path.match(/^\/api\/stock-counts\/([^/]+)$/);
      if (mc) {
        return stockCountDetail(mc[1]) as T;
      }
      const m = path.match(/^\/api\/warehouses\/product\/([^/]+)\/stock$/);
      if (m) {
        return productStock(m[1]) as T;
      }
      throw new Error(`nortex mock: ruta no implementada: ${path}`);
    },
  };
}
