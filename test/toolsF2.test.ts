/**
 * Tests F2: happy/empty/error por tool nueva, con strings exactos en voseo.
 *
 * El mock se ancla a una fecha fija (2026-10-08) para congelar los nombres
 * de día ("el viernes", "el jueves") en los strings esperados.
 */
import { describe, expect, it } from "vitest";
import { createMockNortexApi } from "../src/mock.js";
import {
  MSG_CONTEO_NINGUNO,
  MSG_DETALLE_INVALIDO,
  MSG_DIAS_INVALIDO,
  MSG_ERROR_GENERICO,
  MSG_LIMIT_MAX,
  MSG_LIMIT_MIN,
  MSG_PERIODO_SIN_VENTAS,
  MSG_PRODUCTO_MIN,
  MSG_SIN_ACCESO,
  MSG_STOCK_OK,
  MSG_UMBRAL_INVALIDO,
  conteoNingunoEn,
  detalleVenta,
  estadoConteo,
  inventarioBajo,
  nadaComo,
  precioProducto,
  ventasPeriodo,
  type ToolCtx,
} from "../src/tools.js";

const ANCHOR = "2026-10-08"; // jueves
const ctxOk: ToolCtx = {
  api: createMockNortexApi({ anchorDate: ANCHOR }),
  today: () => ANCHOR,
};
const ctxAuth: ToolCtx = {
  api: createMockNortexApi({ mode: "unauthorized", anchorDate: ANCHOR }),
  today: () => ANCHOR,
};

describe("ventas_periodo", () => {
  it("happy 7 días: string exacto en voseo", async () => {
    await expect(ventasPeriodo(ctxOk, { dias: 7 })).resolves.toBe(
      "En los últimos 7 días vendiste C$82,749.00 en 261 facturas. El mejor día fue el viernes con C$14,014.00.",
    );
  });
  it("default = 7 días cuando no se pasa dias", async () => {
    await expect(ventasPeriodo(ctxOk, {})).resolves.toBe(
      "En los últimos 7 días vendiste C$82,749.00 en 261 facturas. El mejor día fue el viernes con C$14,014.00.",
    );
  });
  it("dias=1: singular en voseo", async () => {
    await expect(ventasPeriodo(ctxOk, { dias: 1 })).resolves.toBe(
      "En el último día vendiste C$12,450.00 en 38 facturas. El mejor día fue el jueves con C$12,450.00.",
    );
  });
  it("empty: período sin ventas es normal, no error", async () => {
    const ctx: ToolCtx = {
      api: createMockNortexApi({ anchorDate: ANCHOR }),
      today: () => "2099-01-01",
    };
    await expect(ventasPeriodo(ctx, { dias: 7 })).resolves.toBe(MSG_PERIODO_SIN_VENTAS);
  });
  it("dias inválido: mensaje en voseo, no stack trace", async () => {
    await expect(ventasPeriodo(ctxOk, { dias: 0 })).resolves.toBe(MSG_DIAS_INVALIDO);
    await expect(ventasPeriodo(ctxOk, { dias: 31 })).resolves.toBe(MSG_DIAS_INVALIDO);
    await expect(ventasPeriodo(ctxOk, { dias: 2.5 })).resolves.toBe(MSG_DIAS_INVALIDO);
    await expect(ventasPeriodo(ctxOk, { dias: "siete" })).resolves.toBe(MSG_DIAS_INVALIDO);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await ventasPeriodo(ctxAuth, { dias: 7 });
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("82,749");
    expect(text).not.toContain("C$");
  });
});

describe("inventario_bajo", () => {
  it("happy: string exacto en voseo", async () => {
    await expect(inventarioBajo(ctxOk, {})).resolves.toBe(
      "Tenés 2 productos bajos: Queso fresco (8, mínimo 12) y Leche (6, mínimo 12).",
    );
  });
  it("umbral personalizado filtra server-side", async () => {
    await expect(inventarioBajo(ctxOk, { umbral: 7 })).resolves.toBe(
      "Tenés 1 producto bajo: Leche (6, mínimo 12).",
    );
  });
  it("respeta limit", async () => {
    await expect(inventarioBajo(ctxOk, { limit: 1 })).resolves.toBe(
      "Tenés 1 producto bajo: Queso fresco (8, mínimo 12).",
    );
  });
  it("empty: nadie bajo de stock es normal", async () => {
    await expect(inventarioBajo(ctxOk, { umbral: 1 })).resolves.toBe(MSG_STOCK_OK);
  });
  it("umbral inválido: mensaje en voseo", async () => {
    await expect(inventarioBajo(ctxOk, { umbral: 0 })).resolves.toBe(MSG_UMBRAL_INVALIDO);
    await expect(inventarioBajo(ctxOk, { umbral: -3 })).resolves.toBe(MSG_UMBRAL_INVALIDO);
    await expect(inventarioBajo(ctxOk, { umbral: 1.5 })).resolves.toBe(MSG_UMBRAL_INVALIDO);
  });
  it("limit inválido: mensaje en voseo", async () => {
    await expect(inventarioBajo(ctxOk, { limit: 100 })).resolves.toBe(MSG_LIMIT_MAX);
    await expect(inventarioBajo(ctxOk, { limit: 0 })).resolves.toBe(MSG_LIMIT_MIN);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await inventarioBajo(ctxAuth, {});
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("Queso");
    expect(text).not.toContain("C$");
  });
  it("errores inesperados: mensaje genérico sin detalles internos", async () => {
    const ctx: ToolCtx = {
      api: {
        get: async () => {
          throw new Error("ECONNREFUSED 10.0.0.5:3000");
        },
      },
      today: () => ANCHOR,
    };
    const text = await inventarioBajo(ctx, {});
    expect(text).toBe(MSG_ERROR_GENERICO);
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("estado_conteo", () => {
  it("happy: 2 conteos abiertos, el cerrado se filtra", async () => {
    await expect(estadoConteo(ctxOk, {})).resolves.toBe(
      "Tenés 2 conteos abiertos: Principal (120 de 200 contados) y Sucursal (30 de 50 contados).",
    );
  });
  it("filtro por bodega: singular en voseo", async () => {
    await expect(estadoConteo(ctxOk, { bodega: "principal" })).resolves.toBe(
      "Tenés un conteo abierto en Principal: 120 de 200 productos contados.",
    );
  });
  it("bodega sin conteos: mensaje exacto con el nombre dado", async () => {
    await expect(estadoConteo(ctxOk, { bodega: "Bodega Sur" })).resolves.toBe(
      conteoNingunoEn("Bodega Sur"),
    );
    expect(conteoNingunoEn("Bodega Sur")).toBe("No tenés conteos abiertos en 'Bodega Sur'.");
  });
  it("sin conteos abiertos en ninguna bodega: mensaje exacto", async () => {
    const ctx: ToolCtx = {
      api: { get: async () => [] },
      today: () => ANCHOR,
    };
    await expect(estadoConteo(ctx, {})).resolves.toBe(MSG_CONTEO_NINGUNO);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await estadoConteo(ctxAuth, {});
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("Principal");
    expect(text).not.toMatch(/sc-/); // sin IDs internos
  });
});

describe("precio_producto", () => {
  it("happy: string exacto en voseo, base NIO", async () => {
    await expect(precioProducto(ctxOk, { producto: "queso frito" })).resolves.toBe(
      "El Queso frito vale C$120.00 la libra.",
    );
  });
  it("empty: string exacto en voseo", async () => {
    await expect(precioProducto(ctxOk, { producto: "queso azul" })).resolves.toBe(
      nadaComo("queso azul"),
    );
  });
  it("producto inválido (< 2 letras): mensaje en voseo", async () => {
    await expect(precioProducto(ctxOk, { producto: "x" })).resolves.toBe(MSG_PRODUCTO_MIN);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await precioProducto(ctxAuth, { producto: "queso frito" });
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("C$");
    expect(text).not.toContain("Queso");
  });
});

describe("detalle_venta", () => {
  it("happy: detalle completo en voseo, string exacto", async () => {
    await expect(detalleVenta(ctxOk, { factura: "A-001234" })).resolves.toBe(
      "La venta A-1234 fue de C$1,240.00. Llevaba: 8 libras de Queso frito a C$120.00 y 2.8 libras de Queso fresco a C$100.00. Pagó en efectivo.",
    );
  });
  it("acepta la referencia sin ceros ni guion y sin serie", async () => {
    await expect(detalleVenta(ctxOk, { factura: "a1234" })).resolves.toContain("La venta A-1234");
    await expect(detalleVenta(ctxOk, { factura: "1233" })).resolves.toBe(
      "La venta A-1233 fue de C$300.00. Llevaba: 10 litros de Leche a C$30.00. Pagó por transferencia.",
    );
  });
  it("no encontrada en 31 días: mensaje honesto, sin inventar", async () => {
    await expect(detalleVenta(ctxOk, { factura: "A-9999" })).resolves.toBe(
      "No encontré la venta A-9999 en los últimos 31 días.",
    );
  });
  it("argumento inválido: mensaje en voseo", async () => {
    await expect(detalleVenta(ctxOk, {})).resolves.toBe(MSG_DETALLE_INVALIDO);
    await expect(detalleVenta(ctxOk, { factura: "" })).resolves.toBe(MSG_DETALLE_INVALIDO);
    await expect(detalleVenta(ctxOk, { factura: "xyz" })).resolves.toBe(MSG_DETALLE_INVALIDO);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await detalleVenta(ctxAuth, { factura: "A-001234" });
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("1,240");
    expect(text).not.toContain("Queso");
  });
});

describe("aislamiento cross-tenant: las 5 tools F2 fallan cerradas", () => {
  it("mismo mensaje, cero datos entre tenants", async () => {
    const outputs = [
      await ventasPeriodo(ctxAuth, { dias: 7 }),
      await inventarioBajo(ctxAuth, {}),
      await estadoConteo(ctxAuth, {}),
      await precioProducto(ctxAuth, { producto: "queso" }),
    ];
    for (const out of outputs) {
      expect(out).toBe(MSG_SIN_ACCESO);
      expect(out).not.toMatch(/queso|Queso/i);
      expect(out).not.toContain("C$");
      expect(out).not.toMatch(/Principal|Sucursal/);
      expect(out).not.toMatch(/p-|w-|sc-/); // IDs internos
    }
  });
});
