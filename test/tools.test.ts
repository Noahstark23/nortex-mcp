import { describe, expect, it } from "vitest";
import { createMockNortexApi } from "../src/mock.js";
import { todayManagua } from "../src/time.js";
import {
  MSG_ERROR_GENERICO,
  MSG_LIMIT_MAX,
  MSG_LIMIT_MIN,
  MSG_PRODUCTO_MIN,
  MSG_Q_MIN,
  MSG_SIN_ACCESO,
  MSG_SIN_VENTAS,
  buscarProducto,
  stockProducto,
  ventasHoy,
  type ToolCtx,
} from "../src/tools.js";

const TODAY = todayManagua();
const ctxOk: ToolCtx = { api: createMockNortexApi(), today: () => TODAY };
const ctxAuth: ToolCtx = {
  api: createMockNortexApi({ mode: "unauthorized" }),
  today: () => TODAY,
};

describe("ventas_hoy", () => {
  it("happy: string exacto en voseo", async () => {
    await expect(ventasHoy(ctxOk)).resolves.toBe(
      "Hoy vendiste C$12,450.00 en 38 facturas. Tu mejor producto fue Queso frito.",
    );
  });
  it("ordena products[] (el mock los devuelve desordenados) sin recalcular dinero", async () => {
    // Si no ordenara, el "mejor" sería Queso seco (primero en el mock).
    const text = await ventasHoy(ctxOk);
    expect(text).toContain("Queso frito");
    expect(text).not.toContain("Queso seco");
  });
  it("empty: día sin ventas es normal, no error", async () => {
    const ctx: ToolCtx = { api: createMockNortexApi(), today: () => "2099-01-01" };
    await expect(ventasHoy(ctx)).resolves.toBe(MSG_SIN_VENTAS);
  });
  it("error 401/403: fail closed con mensaje en voseo, cero datos", async () => {
    const text = await ventasHoy(ctxAuth);
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("12,450");
    expect(text).not.toContain("Queso");
  });
});

describe("buscar_producto", () => {
  it("happy: string exacto en voseo", async () => {
    await expect(buscarProducto(ctxOk, { q: "queso frito" })).resolves.toBe(
      "Queso frito: C$120.00 la libra, te quedan 15 en Principal y 4 en Sucursal.",
    );
  });
  it("varias coincidencias: una línea por producto, sin IDs", async () => {
    const text = await buscarProducto(ctxOk, { q: "queso" });
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    expect(text).toContain("Queso frito: C$120.00 la libra");
    expect(text).toContain("Queso fresco: C$100.00 la libra, te quedan 8 en Principal.");
    expect(text).not.toMatch(/p-queso|w-principal/); // sin IDs internos
  });
  it("respeta limit", async () => {
    const text = await buscarProducto(ctxOk, { q: "queso", limit: 1 });
    expect(text.split("\n")).toHaveLength(1);
  });
  it("empty: string exacto en voseo", async () => {
    await expect(buscarProducto(ctxOk, { q: "queso azul" })).resolves.toBe(
      "No encontré nada como 'queso azul'.",
    );
  });
  it("q inválido (< 2 letras): mensaje en voseo, no stack trace", async () => {
    await expect(buscarProducto(ctxOk, { q: "q" })).resolves.toBe(MSG_Q_MIN);
    await expect(buscarProducto(ctxOk, { q: "  " })).resolves.toBe(MSG_Q_MIN);
    await expect(buscarProducto(ctxOk, {})).resolves.toBe(MSG_Q_MIN);
  });
  it("limit inválido: mensaje en voseo", async () => {
    await expect(buscarProducto(ctxOk, { q: "queso", limit: 100 })).resolves.toBe(MSG_LIMIT_MAX);
    await expect(buscarProducto(ctxOk, { q: "queso", limit: 0 })).resolves.toBe(MSG_LIMIT_MIN);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await buscarProducto(ctxAuth, { q: "queso" });
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("Queso");
    expect(text).not.toContain("C$");
  });
});

describe("stock_producto", () => {
  it("happy: string exacto en voseo", async () => {
    await expect(stockProducto(ctxOk, { producto: "queso frito" })).resolves.toBe(
      "Del Queso frito te quedan 19 libras en total: 15 en Principal, 4 en Sucursal.",
    );
  });
  it("una sola bodega", async () => {
    await expect(stockProducto(ctxOk, { producto: "queso fresco" })).resolves.toBe(
      "Del Queso fresco te quedan 8 libras en total: 8 en Principal.",
    );
  });
  it("empty: string exacto en voseo", async () => {
    await expect(stockProducto(ctxOk, { producto: "queso azul" })).resolves.toBe(
      "No encontré nada como 'queso azul'.",
    );
  });
  it("producto inválido (< 2 letras): mensaje en voseo", async () => {
    await expect(stockProducto(ctxOk, { producto: "x" })).resolves.toBe(MSG_PRODUCTO_MIN);
  });
  it("error 401/403: fail closed, cero datos", async () => {
    const text = await stockProducto(ctxAuth, { producto: "queso frito" });
    expect(text).toBe(MSG_SIN_ACCESO);
    expect(text).not.toContain("19");
    expect(text).not.toContain("Queso");
  });
});

describe("errores inesperados del backend", () => {
  it("no filtran stack trace ni detalles internos", async () => {
    const boom = {
      get: async () => {
        throw new Error("ECONNREFUSED 10.0.0.5:3000 (stack interno)");
      },
    };
    const ctx: ToolCtx = { api: boom, today: () => TODAY };
    for (const fn of [
      () => ventasHoy(ctx),
      () => buscarProducto(ctx, { q: "queso" }),
      () => stockProducto(ctx, { producto: "queso" }),
    ]) {
      const text = await fn();
      expect(text).toBe(MSG_ERROR_GENERICO);
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("10.0.0.5");
    }
  });
});
