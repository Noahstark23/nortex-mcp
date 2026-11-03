/**
 * Tests F6: `resolver_duda` — dudas de uso con fuentes oficiales.
 *
 * Incluye el BANCO DE PRUEBAS del brief (preguntas reales del 2026-10-17):
 * cada una debe caer en la fuente correcta, con los pasos clave y confianza;
 * la pregunta fuera del manual debe devolver "sin fundamento".
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Bm25Index,
  brief,
  buildDocs,
  loadIndex,
  normalize,
  resolve,
  stem,
  tokenize,
  type CasosKb,
  type ManualKb,
} from "../src/knowledge.js";
import {
  MSG_KB_NO_DISPONIBLE,
  MSG_PREGUNTA_MAX,
  MSG_PREGUNTA_MIN,
  MSG_SIN_FUNDAMENTO,
  resolverDuda,
} from "../src/resolverDuda.js";

const KB = new URL("../knowledge/", import.meta.url);
const manual = JSON.parse(readFileSync(new URL("manual.json", KB), "utf8")) as ManualKb;
const casos = JSON.parse(readFileSync(new URL("casos.json", KB), "utf8")) as CasosKb;
const index = loadIndex();

const ask = (pregunta: string) => resolverDuda({ pregunta });
const topId = (pregunta: string) => resolve(index, pregunta).top?.doc.id;

describe("banco de pruebas F6 (preguntas reales)", () => {
  it("1. ¿Puedo vender el mismo producto por caja y por unidad? -> empaque, sí, con pasos", () => {
    const q = "¿Puedo vender el mismo producto por caja y por unidad?";
    expect(topId(q)).toBe("caso:empaque-caja-unidad");
    const text = ask(q);
    expect(text.startsWith("Sí.")).toBe(true);
    expect(text).toContain("Empaque");
    expect(text).toContain("Unid. por empaque");
    expect(text).toContain("«+1 CAJA (12)»");
    expect(text).toMatch(/stock se lleva siempre en unidades/);
    expect(text).toMatch(/^1\. /m);
    expect(text).toContain("Fuente: Caso verificado «Vender el mismo producto por caja y por unidad (empaque)»");
    expect(text).toContain("Confianza: alta");
  });

  it("2. La caja trae un código de barras y la unidad otro -> un solo sku + botón +1 CAJA", () => {
    const q = "La caja trae un código de barras y la unidad otro, ¿cómo hago?";
    expect(topId(q)).toBe("caso:codigo-barras-unico");
    const text = ask(q);
    expect(text).toMatch(/UN solo código \(SKU\)/);
    expect(text).toContain("«+1 CAJA»");
    expect(text).toContain("Fuente: Caso verificado «La caja y la unidad traen códigos de barras distintos»");
    expect(text).toContain("Confianza: alta");
  });

  it("3. ¿Cómo registro regalías? -> ajuste de inventario", () => {
    const q = "¿Cómo registro regalías?";
    expect(topId(q)).toBe("caso:regalias-ajuste-inventario");
    const text = ask(q);
    expect(text).toContain("ajuste de inventario");
    expect(text).toContain("«Registrar pérdida o sobrante»");
    expect(text).toContain("«Pérdida / Merma»");
    expect(text).toContain("«Ganancia / Hallazgo»");
    expect(text).toContain("Justificación");
    expect(text).toContain("Confianza: alta");
  });

  it("4. El POS me rechaza una venta de carne con lotes -> lotes vencidos / FEFO", () => {
    const q = "El POS me rechaza una venta de carne con lotes";
    expect(topId(q)).toBe("caso:lotes-vencidos-fefo");
    const text = ask(q);
    expect(text).toContain("vencimiento de hoy en adelante");
    expect(text).toContain("FEFO");
    expect(text).toContain("«Lotes vigentes insuficientes»");
    expect(text).toContain("Confianza: alta");
  });

  it("5. Pregunta fuera del manual -> sin fundamento, sin inventar", () => {
    const q = "¿Cómo conecto Nortex con mi tienda de Shopify?";
    expect(resolve(index, q).status).toBe("sin_fundamento");
    const text = ask(q);
    expect(text).toBe(MSG_SIN_FUNDAMENTO);
    expect(text).not.toMatch(/^\d\. /m);
    expect(text).not.toContain("Fuente:");
  });
});

describe("resolver_duda: más preguntas fuera de fuente (fail closed)", () => {
  for (const q of [
    "¿Cómo emito una factura electrónica con Verifactu en España?",
    "¿Cómo vendo en Amazon?",
    "¿Cuánto cuesta el plan premium?",
    "¿Puedo usar Nortex sin internet?",
    "xyzzy qwerty asdfgh",
  ]) {
    it(`sin fundamento: ${q}`, () => {
      expect(ask(q)).toBe(MSG_SIN_FUNDAMENTO);
    });
  }
});

describe("resolver_duda: preguntas del manual", () => {
  it.each([
    ["¿Cómo cobro con tarjeta?", "manual:c03:s05"],
    ["¿Cómo le fío a un cliente?", "manual:c03:s06"],
    ["¿Cómo creo un producto nuevo?", "manual:c05:s03"],
    ["¿Cómo configuro mi RUC para facturar?", "manual:c10:s02"],
    ["¿Cómo traslado mercadería entre bodegas?", "manual:c06:s01"],
    ["¿Cómo registro una compra a un proveedor?", "manual:c13:s01"],
    ["¿Cómo calculo la nómina?", "manual:c16:s03"],
  ])("%s -> %s", (q, id) => {
    expect(topId(q)).toBe(id);
    const text = ask(q);
    expect(text).toMatch(/\nFuente: Manual, cap\. \d+ «/);
    expect(text).toMatch(/Confianza: (alta|media)/);
  });

  it("la respuesta del manual es extractiva (texto literal del segmento)", () => {
    const r = resolve(index, "¿Cómo le fío a un cliente?");
    const seg = manual.segments.find((s) => s.id === r.top!.doc.id)!;
    const body = ask("¿Cómo le fío a un cliente?").split("\n\nFuente:")[0]!;
    expect(seg.text.startsWith(body.replace(/ …$/, ""))).toBe(true);
  });

  it("la fuente del manual cita capítulo, figura y página", () => {
    const text = ask("¿Cómo creo un producto nuevo?");
    expect(text).toContain(
      "Fuente: Manual, cap. 5 «Inventario: Mis Productos» › Crear un producto nuevo (Figura 12), p. 15",
    );
  });

  it("anulación en negocio unipersonal marca la limitación conocida sin prometer fechas", () => {
    const text = ask("¿Cómo anulo una venta si trabajo solo?");
    expect(text).toContain("limitación conocida");
    expect(text).toContain("MANAGER");
    expect(text).not.toMatch(/\b(pronto|próxima versión|se arregla|fecha)\b/i);
  });

  it("un solo término informativo nunca da confianza alta", () => {
    const r = resolve(index, "¿Cómo hago una proforma?");
    expect(r.status).toBe("ok");
    expect(r.queryTerms).toHaveLength(1);
    expect(r.confianza).toBe("media");
  });

  it("'ver también' lista fuentes relacionadas", () => {
    expect(ask("¿Puedo vender el mismo producto por caja y por unidad?")).toContain(
      "Ver también: Caso verificado «La caja y la unidad traen códigos de barras distintos»",
    );
  });
});

describe("resolver_duda: validación y fail closed", () => {
  it("pregunta vacía, corta o ausente -> mensaje en voseo", () => {
    expect(resolverDuda({})).toBe(MSG_PREGUNTA_MIN);
    expect(resolverDuda(undefined)).toBe(MSG_PREGUNTA_MIN);
    expect(resolverDuda({ pregunta: "  hi  " })).toBe(MSG_PREGUNTA_MIN);
    expect(resolverDuda({ pregunta: 42 })).toBe(MSG_PREGUNTA_MIN);
  });

  it("pregunta de más de 500 letras -> mensaje en voseo", () => {
    expect(resolverDuda({ pregunta: "caja ".repeat(120) })).toBe(MSG_PREGUNTA_MAX);
  });

  it("si la base no carga, no responde nada del conocimiento", () => {
    const text = resolverDuda({ pregunta: "¿Cómo registro regalías?" }, () => {
      throw new Error("ENOENT manual.json");
    });
    expect(text).toBe(MSG_KB_NO_DISPONIBLE);
    expect(text).not.toContain("ENOENT");
  });

  it("solo stopwords -> sin fundamento", () => {
    expect(ask("¿cómo hago eso en nortex?")).toBe(MSG_SIN_FUNDAMENTO);
  });
});

describe("texto y BM25", () => {
  it("normaliza tildes y mayúsculas", () => {
    expect(normalize("Regalías ÑANDÚ")).toBe("regalias nandu");
  });

  it("stem unifica plurales y conjugaciones", () => {
    expect(stem("cajas")).toBe(stem("caja"));
    expect(stem("lotes")).toBe(stem("lote"));
    expect(stem("vendo")).toBe(stem("venta"));
    expect(stem("vendes")).toBe(stem("vender"));
    expect(stem("fio")).toBe(stem("fiado"));
    expect(stem("unidades")).toBe(stem("unidad"));
  });

  it("tokenize quita stopwords", () => {
    expect(tokenize("¿Cómo hago para vender en Nortex?")).toEqual(["vend"]);
  });

  it("BM25 ordena por relevancia y es determinista", () => {
    const docs = buildDocs(
      { source: manual.source, segments: [] },
      {
        verificadoContra: "test",
        casos: [
          { id: "a", titulo: "Lotes", preguntas: [], keywords: ["lote", "lote"], respuesta: "x", verificacion: { fecha: "f", archivos: ["y"] } },
          { id: "b", titulo: "Cajas", preguntas: [], keywords: ["caja"], respuesta: "x", verificacion: { fecha: "f", archivos: ["y"] } },
        ],
      },
    );
    const idx = new Bm25Index(docs);
    expect(idx.search(["lot"]).map((h) => h.doc.id)).toEqual(["caso:a"]);
    expect(idx.search(["caj", "lot"])).toHaveLength(2);
    expect(idx.search(["zzz"])).toEqual([]);
  });

  it("brief recorta en límite de párrafo u oración", () => {
    const t = "Uno dos tres. ".repeat(100);
    const b = brief(t, 100);
    expect(b.length).toBeLessThanOrEqual(102);
    expect(b.endsWith(". …")).toBe(true);
    expect(brief("corto")).toBe("corto");
  });
});

describe("integridad de la base de conocimiento", () => {
  it("manual.json: los 20 capítulos del índice, segmentos con texto y página", () => {
    const chapters = new Set(manual.segments.map((s) => s.chapter));
    expect(chapters.size).toBe(20);
    for (const s of manual.segments) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.page).toBeGreaterThan(0);
      expect(s.id).toMatch(/^manual:c\d{2}:s\d{2}$/);
    }
    expect(new Set(manual.segments.map((s) => s.id)).size).toBe(manual.segments.length);
    // Las 56 figuras del manual quedan atribuidas a algún segmento.
    const figs = manual.segments.flatMap((s) => s.figures.map((f) => f.n));
    expect(new Set(figs).size).toBe(56);
    expect(manual.source.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  const pdf = join(homedir(), "workspace/your_files/Manual-de-Usuario-Nortex.pdf");
  it.skipIf(!existsSync(pdf))("manual.json corresponde al PDF oficial actual (sha256)", () => {
    const sha = createHash("sha256").update(readFileSync(pdf)).digest("hex");
    expect(manual.source.sha256).toBe(sha);
  });

  it("casos.json: cada caso cita dónde se verificó y cuándo", () => {
    expect(casos.casos.length).toBeGreaterThanOrEqual(5);
    for (const c of casos.casos) {
      expect(c.verificacion.archivos.length).toBeGreaterThan(0);
      expect(c.verificacion.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.respuesta.length).toBeGreaterThan(50);
    }
    expect(new Set(casos.casos.map((c) => c.id)).size).toBe(casos.casos.length);
  });
});
