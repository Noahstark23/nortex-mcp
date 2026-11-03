/**
 * Tests F5: `informe_ventas` — el Reporte integral a pedido.
 *
 * Se usa un stub de NortexApi determinista (la forma completa verificada
 * contra backend/lib/salesReport.ts): el orden por cantidad y el orden por
 * utilidad del fixture son DISTINTOS a propósito, y los productos/métodos
 * llegan desordenados, para probar que la tool ordena de verdad.
 * Hoy fijo: 2026-10-15 (jueves).
 */
import { describe, expect, it } from "vitest";
import { NortexAuthError, type NortexApi } from "../src/nortexApi.js";
import { createMockNortexApi } from "../src/mock.js";
import {
  MSG_ERROR_GENERICO,
  MSG_INFORME_PERIODO_INVALIDO,
  MSG_INFORME_RANGO_INVALIDO,
  MSG_INFORME_RANGO_MAX,
  MSG_INFORME_TOP_INVALIDO,
  MSG_PERIODO_SIN_VENTAS,
  MSG_SIN_ACCESO,
  informeVentas,
  type ToolCtx,
} from "../src/tools.js";
import type { SalesReportFull } from "../src/types.js";

const TODAY = "2026-10-15";

const REPORT: SalesReportFull = {
  daily: [],
  summary: {
    grossSales: "90125.00",
    returnsTotal: "1376.00",
    netSales: "82749.00",
    vatCollected: "10815.00",
    netRevenue: "71934.00",
    cogs: "47617.00",
    grossProfit: "24317.00",
    transactionCount: 261,
    returnCount: 2,
    averageTicket: "317.05",
    discountTotal: "0.00",
  },
  paymentMethods: [
    {
      method: "TRANSFER",
      label: "Transferencia",
      transactionCount: 104,
      returnCount: 1,
      grossSales: "34475.00",
      returnsTotal: "1376.00",
      netSales: "33099.00",
    },
    {
      method: "CASH",
      label: "Efectivo",
      transactionCount: 157,
      returnCount: 1,
      grossSales: "55650.00",
      returnsTotal: "0.00",
      netSales: "49650.00",
    },
  ],
  products: [
    {
      productId: "p-seco",
      productName: "Queso seco",
      quantitySold: "22.0000",
      quantityReturned: "0.0000",
      quantityNet: "22.0000",
      netSales: "2100.00",
      grossProfit: "1500.00",
      displayUnit: "libra",
      unit: "libra",
    },
    {
      productId: "p-frito",
      productName: "Queso frito",
      quantitySold: "70.8333",
      quantityReturned: "0.0000",
      quantityNet: "70.8333",
      netSales: "8500.00",
      grossProfit: "2975.00",
      displayUnit: "libra",
      unit: "libra",
    },
    {
      productId: "p-fresco",
      productName: "Queso fresco",
      quantitySold: "18.5000",
      quantityReturned: "0.0000",
      quantityNet: "18.5000",
      netSales: "1850.00",
      grossProfit: "2000.00",
      displayUnit: "libra",
      unit: "libra",
    },
  ],
};

interface RecordedCall {
  path: string;
  query?: Record<string, string | number>;
}

function stubCtx(report: unknown, today: string = TODAY): { ctx: ToolCtx; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const api: NortexApi = {
    async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
      calls.push({ path, query });
      return report as T;
    },
  };
  return { ctx: { api, today: () => today }, calls };
}

describe("informe_ventas", () => {
  it("happy (default = mes): string exacto, resumen de voz + detalle ordenado", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    const text = await informeVentas(ctx, {});
    expect(text).toBe(
      [
        "En los últimos 30 días vendiste C$82,749 en 261 facturas, con utilidad bruta de C$24,317. Tu producto más vendido fue el Queso frito.",
        "",
        "Detalle del informe · 16 sep – 15 oct 2026 · 30 días:",
        "Ventas brutas: C$90,125",
        "Devoluciones: C$1,376 en 2 devoluciones",
        "Ventas netas: C$82,749",
        "IVA recaudado: C$10,815",
        "Utilidad bruta: C$24,317",
        "Ticket promedio: C$317 · 261 facturas",
        "",
        "Cómo te pagaron:",
        "Efectivo: C$49,650 (157 facturas)",
        "Transferencia: C$33,099 (104 facturas)",
        "",
        "Lo que más se vendió:",
        "1. Queso frito: 70.8333 libras · C$8,500 de venta neta",
        "2. Queso seco: 22 libras · C$2,100 de venta neta",
        "3. Queso fresco: 18.5 libras · C$1,850 de venta neta",
        "",
        "Lo que más utilidad dejó:",
        "1. Queso frito: C$2,975",
        "2. Queso fresco: C$2,000",
        "3. Queso seco: C$1,500",
      ].join("\n"),
    );
    // UNA sola llamada al endpoint del Reporte integral, con el rango resuelto.
    expect(calls).toEqual([
      { path: "/api/reports/sales", query: { startDate: "2026-09-16", endDate: "2026-10-15" } },
    ]);
  });

  it("aislamiento: la tool jamás envía tenantId (sale de la sesión, no del pedido)", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    await informeVentas(ctx, { periodo: "semana" });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].query ?? {}).sort()).toEqual(["endDate", "startDate"]);
    expect(JSON.stringify(calls[0].query)).not.toContain("tenant");
  });

  it("el resumen hablado respeta el contrato de voz (≤ 25 palabras)", async () => {
    const { ctx } = stubCtx(REPORT);
    const text = await informeVentas(ctx, {});
    const voz = text.split("\n\n")[0];
    expect(voz.split(/\s+/).length).toBeLessThanOrEqual(25);
  });

  it("rankings: el orden por cantidad y el orden por utilidad son independientes", async () => {
    const { ctx } = stubCtx(REPORT);
    const text = await informeVentas(ctx, {});
    const idxCantidad = text.indexOf("Lo que más se vendió:");
    const idxUtilidad = text.indexOf("Lo que más utilidad dejó:");
    const seccionCantidad = text.slice(idxCantidad, idxUtilidad);
    const seccionUtilidad = text.slice(idxUtilidad);
    // Cantidad: frito > seco > fresco. Utilidad: frito > fresco > seco.
    expect(seccionCantidad.indexOf("Queso seco")).toBeLessThan(seccionCantidad.indexOf("Queso fresco"));
    expect(seccionUtilidad.indexOf("Queso fresco")).toBeLessThan(seccionUtilidad.indexOf("Queso seco"));
  });

  it("periodo hoy: rango de un día y etiqueta «Hoy»", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    const text = await informeVentas(ctx, { periodo: "hoy" });
    expect(calls[0].query).toEqual({ startDate: TODAY, endDate: TODAY });
    expect(text.startsWith("Hoy vendiste C$82,749 en 261 facturas")).toBe(true);
    expect(text).toContain("Detalle del informe · 15 oct 2026 · 1 día:");
  });

  it("periodo ayer: rango de ayer y etiqueta «Ayer»", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    const text = await informeVentas(ctx, { periodo: "ayer" });
    expect(calls[0].query).toEqual({ startDate: "2026-10-14", endDate: "2026-10-14" });
    expect(text.startsWith("Ayer vendiste")).toBe(true);
  });

  it("periodo semana: últimos 7 días", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    const text = await informeVentas(ctx, { periodo: "semana" });
    expect(calls[0].query).toEqual({ startDate: "2026-10-09", endDate: "2026-10-15" });
    expect(text.startsWith("En los últimos 7 días vendiste")).toBe(true);
    expect(text).toContain("· 7 días:");
  });

  it("rango personalizado de 31 días exactos: pasa", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    const text = await informeVentas(ctx, { desde: "2026-09-15", hasta: "2026-10-15" });
    expect(calls[0].query).toEqual({ startDate: "2026-09-15", endDate: "2026-10-15" });
    expect(text.startsWith("En ese período vendiste")).toBe(true);
    expect(text).toContain("· 31 días:");
  });

  it("rango de 32 días: rechazado sin tocar la red", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    await expect(
      informeVentas(ctx, { desde: "2026-09-14", hasta: "2026-10-15" }),
    ).resolves.toBe(MSG_INFORME_RANGO_MAX);
    expect(calls).toHaveLength(0);
  });

  it("rangos inválidos: mensaje en voseo y cero llamadas", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    await expect(
      informeVentas(ctx, { desde: "2026-10-15", hasta: "2026-10-14" }),
    ).resolves.toBe(MSG_INFORME_RANGO_INVALIDO);
    await expect(
      informeVentas(ctx, { desde: "2026-10-10", hasta: "2026-10-16" }), // futuro
    ).resolves.toBe(MSG_INFORME_RANGO_INVALIDO);
    await expect(
      informeVentas(ctx, { desde: "15/10/2026", hasta: "2026-10-15" }), // formato
    ).resolves.toBe(MSG_INFORME_RANGO_INVALIDO);
    await expect(
      informeVentas(ctx, { desde: "2026-10-10" }), // falta hasta
    ).resolves.toBe(MSG_INFORME_RANGO_INVALIDO);
    await expect(
      informeVentas(ctx, { desde: "2026-02-30", hasta: "2026-10-15" }), // fecha irreal
    ).resolves.toBe(MSG_INFORME_RANGO_INVALIDO);
    expect(calls).toHaveLength(0);
  });

  it("período desconocido: mensaje en voseo", async () => {
    const { ctx, calls } = stubCtx(REPORT);
    await expect(informeVentas(ctx, { periodo: "trimestre" })).resolves.toBe(
      MSG_INFORME_PERIODO_INVALIDO,
    );
    expect(calls).toHaveLength(0);
  });

  it("período vacío: sin ventas es normal, no error", async () => {
    const empty: SalesReportFull = {
      ...REPORT,
      summary: { ...REPORT.summary, transactionCount: 0, netSales: "0.00" },
    };
    const { ctx } = stubCtx(empty);
    await expect(informeVentas(ctx, { periodo: "hoy" })).resolves.toBe(MSG_PERIODO_SIN_VENTAS);
  });

  it("401/403: fail closed, cero datos del negocio", async () => {
    const api: NortexApi = {
      async get<T>(): Promise<T> {
        throw new NortexAuthError();
      },
    };
    const ctx: ToolCtx = { api, today: () => TODAY };
    const text = await informeVentas(ctx, {});
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("82,749");
    expect(text).not.toContain("C$");
    expect(text).not.toContain("Queso");
  });

  it("error del backend: mensaje humano, sin stack trace", async () => {
    const api: NortexApi = {
      async get<T>(): Promise<T> {
        throw new Error("boom interno");
      },
    };
    const ctx: ToolCtx = { api, today: () => TODAY };
    await expect(informeVentas(ctx, {})).resolves.toBe(MSG_ERROR_GENERICO);
  });

  it("top configurable: top=1 recorta ambos rankings; top=6 se rechaza", async () => {
    const { ctx } = stubCtx(REPORT);
    const text = await informeVentas(ctx, { top: 1 });
    expect(text).toContain("1. Queso frito: 70.8333 libras · C$8,500 de venta neta");
    expect(text).not.toContain("2. Queso seco");
    await expect(informeVentas(ctx, { top: 6 })).resolves.toBe(MSG_INFORME_TOP_INVALIDO);
  });

  it("sin devoluciones: la línea de devoluciones no aparece", async () => {
    const sinDev: SalesReportFull = {
      ...REPORT,
      summary: { ...REPORT.summary, returnCount: 0, returnsTotal: "0.00" },
    };
    const { ctx } = stubCtx(sinDev);
    const text = await informeVentas(ctx, {});
    expect(text).not.toContain("Devoluciones:");
  });

  it("contra el mock: responde con el consolidado y el más vendido", async () => {
    const ANCHOR = "2026-10-08";
    const ctx: ToolCtx = {
      api: createMockNortexApi({ anchorDate: ANCHOR }),
      today: () => ANCHOR,
    };
    const text = await informeVentas(ctx, { periodo: "mes" });
    expect(text).toContain("Detalle del informe");
    expect(text).toContain("Lo que más se vendió:");
    expect(text).toContain("Tu producto más vendido fue el Queso frito.");
  });
});
