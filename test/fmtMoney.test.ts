import { describe, expect, it } from "vitest";
import { fmtMoney, fmtQty, fmtVoiceMoney, joinList, pluralUnit } from "../src/fmtMoney.js";

describe("fmtMoney (único lugar de formateo de dinero)", () => {
  it("formatea número entero", () => {
    expect(fmtMoney(120)).toBe("C$120.00");
  });
  it("formatea string decimal del backend", () => {
    expect(fmtMoney("12450.00")).toBe("C$12,450.00");
  });
  it("agrupa miles con coma", () => {
    expect(fmtMoney(1250)).toBe("C$1,250.00");
    expect(fmtMoney("1234567.89")).toBe("C$1,234,567.89");
  });
  it("cero y redondeo", () => {
    expect(fmtMoney(0)).toBe("C$0.00");
    expect(fmtMoney(1.999)).toBe("C$2.00");
    expect(fmtMoney("0.1")).toBe("C$0.10");
  });
  it("negativos", () => {
    expect(fmtMoney(-50)).toBe("-C$50.00");
  });
  it("rechaza no numéricos sin filtrar nada raro", () => {
    expect(() => fmtMoney("abc")).toThrow("fmtMoney");
    expect(() => fmtMoney(NaN)).toThrow("fmtMoney");
  });
});

describe("fmtQty (stock toFixed(4) -> voz)", () => {
  it("quita decimales innecesarios", () => {
    expect(fmtQty("19.0000")).toBe("19");
    expect(fmtQty("15.0000")).toBe("15");
  });
  it("conserva decimales reales", () => {
    expect(fmtQty("4.5000")).toBe("4.5");
    expect(fmtQty("0.2500")).toBe("0.25");
  });
});

describe("pluralUnit", () => {
  it("1 -> singular", () => {
    expect(pluralUnit("libra", 1)).toBe("libra");
  });
  it("n -> plural", () => {
    expect(pluralUnit("libra", 19)).toBe("libras");
    expect(pluralUnit("libra", "19.0000")).toBe("libras");
  });
});

describe("fmtVoiceMoney (voz: sin centavos, T6 §4.1.3)", () => {
  it("redondea a la unidad y agrupa miles", () => {
    expect(fmtVoiceMoney("18450.00")).toBe("C$18,450");
    expect(fmtVoiceMoney("82749.49")).toBe("C$82,749");
    expect(fmtVoiceMoney("82749.50")).toBe("C$82,750");
    expect(fmtVoiceMoney(120)).toBe("C$120");
  });
  it("USD se lee «dólares»", () => {
    expect(fmtVoiceMoney("48.00", "USD")).toBe("$48 dólares");
  });
  it("negativo conserva el signo", () => {
    expect(fmtVoiceMoney("-1234.56")).toBe("-C$1,235");
  });
});

describe("joinList", () => {
  it("une con 'y'", () => {
    expect(joinList(["15 en Principal"])).toBe("15 en Principal");
    expect(joinList(["15 en Principal", "4 en Sucursal"])).toBe("15 en Principal y 4 en Sucursal");
    expect(joinList(["a", "b", "c"])).toBe("a, b y c");
  });
});
