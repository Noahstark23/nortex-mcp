/**
 * Formas mínimas que las tools necesitan de cada endpoint.
 * Derivadas de `CONTRATOS-F0-BORRADOR.md` (T4-02) y VERIFICADAS CONTRA EL
 * CÓDIGO DEL MONOLITO el 2026-10-14 (nortex.20: backend/routes/productCatalog.ts,
 * backend/routes/salesReports.ts + backend/lib/salesReport.ts,
 * backend/routes/warehouses.ts + backend/services/productWarehouseSnapshot.ts,
 * backend/server.ts GET /api/stock-counts[/:id], schema StockCountItem).
 * Siguen SIN verificar contra staging vivo (eso es F3, requiere JWT).
 */

// E5a — GET /api/reports/sales
export interface ReportDaily {
  date: string; // YYYY-MM-DD, día civil America/Managua
  /** Lo cobrado (bruto, con IVA incluido cuando aplica). Es "lo que entró a caja". */
  grossSales: string; // string decimal
  returnsTotal: string; // string decimal
  returnCount: number;
  /** (bruto − devoluciones) − IVA: NO es lo que entró a caja (ver ventasHoy). */
  netSales: string; // string decimal
  transactionCount: number;
}
export interface ReportProduct {
  productId: string;
  productName: string;
  grossSales: string; // string decimal
  netSales: string; // string decimal
  quantityNet: string; // string decimal
}

// Detalle de venta — GET /api/reports/sales/transaction-detail?reference=A-15
// (ACCESO-IA-DETALLE-01): endpoint acotado para la credencial de IA. El
// backend ya resolvió tenant, ventana de 31 días y exclusión de anuladas;
// la respuesta trae solo el total cobrado y las líneas del snapshot, sin
// costos ni márgenes.
export interface SaleTransactionDetailItem {
  name: string;
  quantity: number;
  unit: string | null;
  priceAtSale: string; // string decimal
}
export interface SaleTransactionDetail {
  reference: string; // "A-15"
  date: string; // ISO
  total: string; // string decimal, total cobrado (bruto)
  customerName: string | null;
  paymentMethod: string;
  status: string;
  items: SaleTransactionDetailItem[];
}
export interface SalesReport {
  products: ReportProduct[];
  daily: ReportDaily[];
}

// E5a-completo — GET /api/reports/sales devuelve el «Reporte integral» entero
// (backend/lib/salesReport.ts `SalesReportData`, verificado 2026-10-15):
// summary + paymentMethods + products con utilidad. Lo consume `informe_ventas`
// (F5). Los montos llegan CALCULADOS por el backend como strings decimales;
// el MCP solo ordena y formatea.
export interface SalesReportSummary {
  grossSales: string;
  returnsTotal: string;
  netSales: string;
  vatCollected: string;
  netRevenue: string;
  cogs: string;
  grossProfit: string;
  transactionCount: number;
  returnCount: number;
  averageTicket: string;
  discountTotal: string;
}
export interface SalesReportPaymentMethod {
  method: string;
  label: string;
  transactionCount: number;
  returnCount: number;
  grossSales: string;
  returnsTotal: string;
  netSales: string;
}
export interface ReportProductFull extends ReportProduct {
  quantitySold: string;
  quantityReturned: string;
  grossProfit: string;
  /** Unidad de exhibición del reporte (p. ej. "libra"); `unit` es la base. */
  displayUnit?: string;
  unit?: string;
}
export interface SalesReportFull extends SalesReport {
  business?: { name: string; taxId?: string };
  period?: { startDate: string; endDate: string; days: number };
  summary: SalesReportSummary;
  paymentMethods: SalesReportPaymentMethod[];
  products: ReportProductFull[];
}

// E1 — GET /api/products (forma paginada; sin `page` el backend devuelve arreglo)
export interface CatalogProduct {
  id: string;
  name: string;
  price: number; // Float en Prisma -> número JSON
  unit: string;
}
export interface CatalogPage {
  products: CatalogProduct[];
  total: number;
  page: number;
  pageSize: number;
}

// E1 — low stock: extensión del catálogo con los campos de reposición.
// El backend filtra `lowStock=true` (Number(stock) <= Number(minStock));
export interface LowStockProduct extends CatalogProduct {
  stock: number; // Float Prisma -> número JSON
  minStock: number; // Float Prisma -> número JSON (punto de reorden)
}

// StockCount — GET /api/stock-counts (decisión F0 §"Punto 3": entra en v1).
// Forma real verificada (backend/server.ts, 2026-10-14): filas Prisma con
// `warehouse`, `creator` y `_count.items` (SOLO el total). La lista NO trae el
// avance (cuántos van contados): eso se calcula del detalle.
export type StockCountStatus = "OPEN" | "CLOSING" | "CLOSED" | "CANCELLED";
export interface StockCountSummary {
  id: string;
  status: StockCountStatus;
  warehouse: { id: string; name: string };
  creator?: { name: string };
  /** Total de ítems del conteo (único conteo que expone la lista). */
  _count: { items: number };
}

// StockCount detalle — GET /api/stock-counts/:id -> { count, items }.
// StockCountItem.counted es Float nullable: null = todavía no contado
// (backend/prisma/schema.prisma, model StockCountItem).
export interface StockCountDetailItem {
  counted: number | null;
}
export interface StockCountDetail {
  count: { id: string; status: StockCountStatus };
  items: StockCountDetailItem[];
}
// E4 — GET /api/warehouses/product/:productId/stock
export interface StockWarehouse {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  stock: string; // string con 4 decimales ("19.0000"), inconsistente con E3
  implicit: boolean;
}
export interface ProductStock {
  productId: string;
  totalStock: string; // string con 4 decimales
  unit: string;
  warehouses: StockWarehouse[];
  hasMore: boolean;
}
