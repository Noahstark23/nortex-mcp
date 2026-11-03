import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { createHttpNortexApi, NortexApiError, NortexAuthError } from "../src/nortexApi.js";
import { createMockNortexApi } from "../src/mock.js";
import { todayManagua } from "../src/time.js";
import {
  MSG_SIN_ACCESO,
  buscarProducto,
  stockProducto,
  ventasHoy,
  type ToolCtx,
} from "../src/tools.js";

const TODAY = todayManagua();

describe("aislamiento cross-tenant (token ajeno / revocado)", () => {
  // El mock en modo unauthorized simula: JWT de otro tenant, revocado o ausente.
  const ctx: ToolCtx = {
    api: createMockNortexApi({ mode: "unauthorized" }),
    today: () => TODAY,
  };

  it("las 3 tools fallan cerradas con el mismo mensaje", async () => {
    await expect(ventasHoy(ctx)).resolves.toBe(MSG_SIN_ACCESO);
    await expect(buscarProducto(ctx, { q: "queso" })).resolves.toBe(MSG_SIN_ACCESO);
    await expect(stockProducto(ctx, { producto: "queso" })).resolves.toBe(MSG_SIN_ACCESO);
  });

  it("cero datos entre tenants: ni nombres, ni dinero, ni bodegas, ni IDs", async () => {
    const outputs = [
      await ventasHoy(ctx),
      await buscarProducto(ctx, { q: "queso" }),
      await stockProducto(ctx, { producto: "queso" }),
    ];
    for (const out of outputs) {
      expect(out).not.toMatch(/queso|Queso/i);
      expect(out).not.toContain("C$");
      expect(out).not.toMatch(/Principal|Sucursal/);
      expect(out).not.toMatch(/p-|w-/); // IDs internos
    }
  });
});

describe("createHttpNortexApi: token solo vía env, nunca en logs", () => {
  let baseUrl = "";
  let server: ReturnType<typeof createServer>;
  let lastAuthHeader = "";

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastAuthHeader = (req.headers.authorization ?? "") as string;
      if (lastAuthHeader !== "Bearer token-del-tenant-A") {
        res.writeHead(401).end(); // token ajeno -> 401
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("envía el token solo en el header Authorization", async () => {
    const api = createHttpNortexApi({ baseUrl, token: "token-del-tenant-A" });
    await expect(api.get("/api/products")).resolves.toEqual({ ok: true });
    expect(lastAuthHeader).toBe("Bearer token-del-tenant-A");
  });

  it("401/403 del backend -> NortexAuthError (fail closed), sin el token en el error", async () => {
    const api = createHttpNortexApi({ baseUrl, token: "token-de-otro-tenant" });
    const err = await api.get("/api/products").catch((e) => e);
    expect(err).toBeInstanceOf(NortexAuthError);
    expect(String(err)).not.toContain("token-de-otro-tenant");
  });

  it("otros errores HTTP no exponen detalles internos", async () => {
    const api = createHttpNortexApi({ baseUrl: "http://127.0.0.1:1", token: "x" });
    const err = await api.get("/api/products").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("token");
  });

  it("error genérico conserva el status", () => {
    const err = new NortexApiError(500, "boom");
    expect(err.status).toBe(500);
  });
});
