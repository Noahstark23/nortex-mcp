import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createHttpNortexApi, unwrapEnvelope } from "../src/nortexApi.js";

/**
 * Formas reales del backend (verificadas contra el código del monolito,
 * 2026-10-14): `GET /api/warehouses/product/:id/stock` envuelve en
 * `{ success: true, data }`; el resto de los endpoints de las tools NO.
 */
describe("unwrapEnvelope", () => {
  it("desenvuelve { success: true, data }", () => {
    expect(unwrapEnvelope({ success: true, data: { totalStock: "19.0000" } })).toEqual({
      totalStock: "19.0000",
    });
  });
  it("deja intactas las formas sin envoltura", () => {
    const page = { products: [], total: 0, page: 1, pageSize: 10 };
    expect(unwrapEnvelope(page)).toBe(page);
    const arr = [{ id: "sc-1" }];
    expect(unwrapEnvelope(arr)).toBe(arr);
    expect(unwrapEnvelope({ success: false, data: 1 })).toEqual({ success: false, data: 1 });
    expect(unwrapEnvelope(null)).toBeNull();
    expect(unwrapEnvelope("texto")).toBe("texto");
  });
});

describe("createHttpNortexApi contra formas reales", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.startsWith("/api/warehouses/product/")) {
        // Forma real: backend/routes/warehouses.ts responde { success, data }.
        res.end(
          JSON.stringify({
            success: true,
            data: { productId: "p-1", totalStock: "19.0000", unit: "libra", warehouses: [], hasMore: false },
          }),
        );
        return;
      }
      // Forma real sin envoltura: lista de conteos (backend/server.ts).
      res.end(JSON.stringify([{ id: "sc-1", status: "OPEN", _count: { items: 200 } }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("stock por bodega: la tool recibe el payload desenvuelto", async () => {
    const api = createHttpNortexApi({ baseUrl, token: "t" });
    const stock = await api.get<{ totalStock: string }>("/api/warehouses/product/p-1/stock");
    expect(stock.totalStock).toBe("19.0000");
  });

  it("conteos: la lista llega sin tocar", async () => {
    const api = createHttpNortexApi({ baseUrl, token: "t" });
    const counts = await api.get<{ _count: { items: number } }[]>("/api/stock-counts");
    expect(counts[0]._count.items).toBe(200);
  });
});
