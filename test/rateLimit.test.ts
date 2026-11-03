import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_LIMIT_PER_MIN,
  RateLimiter,
  rateLimitFromEnv,
} from "../src/rateLimit.js";
import { MSG_RATE_LIMIT } from "../src/tools.js";

describe("RateLimiter", () => {
  it("permite hasta el límite y bloquea el siguiente", () => {
    let t = 0;
    const rl = new RateLimiter(3, () => t);
    expect(rl.allow("tenant-A")).toBe(true);
    expect(rl.allow("tenant-A")).toBe(true);
    expect(rl.allow("tenant-A")).toBe(true);
    expect(rl.allow("tenant-A")).toBe(false);
  });
  it("la ventana se libera después de 60 s", () => {
    let t = 0;
    const rl = new RateLimiter(1, () => t);
    expect(rl.allow("tenant-A")).toBe(true);
    expect(rl.allow("tenant-A")).toBe(false);
    t = 60_001;
    expect(rl.allow("tenant-A")).toBe(true);
  });
  it("el límite es por clave (tenant/sesión)", () => {
    let t = 0;
    const rl = new RateLimiter(1, () => t);
    expect(rl.allow("tenant-A")).toBe(true);
    expect(rl.allow("tenant-B")).toBe(true);
    expect(rl.allow("tenant-A")).toBe(false);
  });
  it("constructor rechaza límites inválidos", () => {
    expect(() => new RateLimiter(0)).toThrow();
    expect(() => new RateLimiter(-5)).toThrow();
    expect(() => new RateLimiter(1.5)).toThrow();
  });
});

describe("rateLimitFromEnv", () => {
  it("default 30 cuando la variable no existe o es inválida", () => {
    expect(DEFAULT_RATE_LIMIT_PER_MIN).toBe(30);
    delete process.env.NORTEX_RATE_LIMIT_PER_MIN;
    expect(rateLimitFromEnv()).toBe(30);
    process.env.NORTEX_RATE_LIMIT_PER_MIN = "no-numero";
    expect(rateLimitFromEnv()).toBe(30);
    process.env.NORTEX_RATE_LIMIT_PER_MIN = "0";
    expect(rateLimitFromEnv()).toBe(30);
    delete process.env.NORTEX_RATE_LIMIT_PER_MIN;
  });
  it("respeta un valor válido del entorno", () => {
    process.env.NORTEX_RATE_LIMIT_PER_MIN = "5";
    expect(rateLimitFromEnv()).toBe(5);
    delete process.env.NORTEX_RATE_LIMIT_PER_MIN;
  });
});

describe("MSG_RATE_LIMIT", () => {
  it("string exacto en voseo, sin datos del negocio", () => {
    expect(MSG_RATE_LIMIT).toBe("Estás yendo muy rápido. Esperá un momento y probá de nuevo.");
  });
});
