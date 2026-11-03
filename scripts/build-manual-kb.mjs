#!/usr/bin/env node
/**
 * F6 — Construye la base de conocimiento local desde el Manual de Usuario PDF.
 *
 * Uso: node scripts/build-manual-kb.mjs [ruta.pdf]
 *   default: ~/workspace/your_files/Manual-de-Usuario-Nortex.pdf
 * Salida: knowledge/manual.json (versionado en el repo: el servidor y los
 * tests NO necesitan el PDF ni pdftotext en runtime).
 *
 * Requiere `pdftotext` (poppler-utils). Segmenta por capítulo (del índice del
 * propio manual) y por subsección; cada segmento lleva sus figuras y página.
 * Determinista: misma entrada -> mismo JSON.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PDF = process.argv[2] ?? join(homedir(), "workspace/your_files/Manual-de-Usuario-Nortex.pdf");
const OUT = join(ROOT, "knowledge/manual.json");
const MIN_SEGMENT_CHARS = 90;

const pdfBytes = readFileSync(PDF);
const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
const raw = execFileSync("pdftotext", ["-enc", "UTF-8", PDF, "-"], { encoding: "utf8", maxBuffer: 32 << 20 });

// Líneas con número de página (pdftotext separa páginas con \f).
const lines = [];
raw.split("\f").forEach((pageText, i) => {
  for (const text of pageText.split("\n")) lines.push({ text: text.trim(), page: i + 1 });
});

// ---- Índice: "N. Título" entre "Índice" y el primer capítulo ----
const idxStart = lines.findIndex((l) => l.text === "Índice");
if (idxStart < 0) throw new Error("No encontré el Índice del manual");
const chapters = [];
for (let i = idxStart + 1; i < lines.length; i++) {
  const m = /^(\d{1,2})\. (.+)$/.exec(lines[i].text);
  if (!m) break;
  chapters.push({ n: Number(m[1]), title: m[2] });
}
if (chapters.length < 10) throw new Error(`Índice incompleto (${chapters.length} capítulos)`);
const afterIndex = idxStart + 1 + chapters.length;

// ---- Ubicar el inicio de cada capítulo en el cuerpo ----
const starts = [];
let cursor = afterIndex;
for (const ch of chapters) {
  const prefix = `${ch.n}. `;
  let found = -1;
  for (let i = cursor; i < lines.length; i++) {
    const t = lines[i].text;
    if (t.startsWith(prefix) && ch.title.startsWith(t.slice(prefix.length))) {
      found = i;
      break;
    }
  }
  if (found < 0) throw new Error(`No encontré el capítulo ${ch.n} «${ch.title}» en el cuerpo`);
  // Títulos largos se parten en dos líneas ("...personal" + "en casa").
  let bodyStart = found + 1;
  const firstLine = lines[found].text.slice(prefix.length);
  if (firstLine !== ch.title && lines[bodyStart] && ch.title === `${firstLine} ${lines[bodyStart].text}`) bodyStart++;
  starts.push({ ch, headingAt: found, bodyStart, page: lines[found].page });
  cursor = bodyStart;
}
// Pie final del manual: no es contenido.
let bodyEnd = lines.findIndex((l, i) => i > cursor && l.text.startsWith("Manual de Usuario Nortex · Edición"));
if (bodyEnd < 0) bodyEnd = lines.length;

const isHeading = (arr, i) => {
  const t = arr[i]?.text ?? "";
  const prev = arr[i - 1]?.text ?? "";
  const next = arr[i + 1]?.text ?? "";
  return (
    t.length >= 4 &&
    t.length <= 60 &&
    prev === "" &&
    next !== "" &&
    /^[A-ZÁÉÍÓÚÑ¿]/.test(t) &&
    !/[.,;:]$/.test(t) &&
    /[a-záéíóúñ]{3,}/.test(t) &&
    !t.startsWith("Figura ")
  );
};

/** Junta líneas en párrafos; "1" + texto -> "1. texto"; separa figuras. */
function render(block) {
  const paras = [];
  const figures = [];
  let cur = [];
  let pendingStep = null;
  let inFigure = null;
  const flush = () => {
    if (cur.length) paras.push(cur.join(" "));
    cur = [];
  };
  for (const { text } of block) {
    if (text === "") {
      if (inFigure) {
        figures.push(inFigure);
        inFigure = null;
      } else if (pendingStep === null) flush();
      continue;
    }
    if (inFigure) {
      inFigure.caption += ` ${text}`;
      continue;
    }
    const fig = /^Figura (\d+) · (.*)$/.exec(text);
    if (fig) {
      flush();
      inFigure = { n: Number(fig[1]), caption: fig[2] };
      continue;
    }
    if (/^\d{1,2}$/.test(text)) {
      flush();
      pendingStep = text;
      continue;
    }
    if (pendingStep !== null) {
      cur.push(`${pendingStep}. ${text}`);
      pendingStep = null;
      continue;
    }
    cur.push(text);
  }
  if (inFigure) figures.push(inFigure);
  flush();
  return { text: paras.join("\n"), figures };
}

const segments = [];
starts.forEach((s, k) => {
  const end = k + 1 < starts.length ? starts[k + 1].headingAt : bodyEnd;
  const body = lines.slice(s.bodyStart, end);
  // Cortes en subtítulos (índices relativos a body; el 0 siempre abre).
  const cuts = [{ at: 0, title: null }];
  const padded = [{ text: "" }, ...body, { text: "" }];
  for (let i = 0; i < body.length; i++) {
    if (!isHeading(padded, i + 1)) continue;
    if (i === 0) cuts[0].title = body[0].text;
    else cuts.push({ at: i, title: body[i].text });
  }
  const parts = cuts.map((c, j) => {
    const from = c.title ? c.at + 1 : c.at;
    const to = j + 1 < cuts.length ? cuts[j + 1].at : body.length;
    return { title: c.title, page: body[c.at]?.page ?? s.page, ...render(body.slice(from, to)) };
  });
  // Fusionar segmentos chicos (celdas de tabla, títulos sin cuerpo) con el anterior.
  const merged = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (prev && p.text.length < MIN_SEGMENT_CHARS) {
      prev.text = [prev.text, p.title, p.text].filter(Boolean).join("\n");
      prev.figures.push(...p.figures);
    } else merged.push({ ...p, figures: [...p.figures] });
  }
  merged
    .filter((p) => p.text.trim().length > 0)
    .forEach((p, j) => {
      segments.push({
        id: `manual:c${String(s.ch.n).padStart(2, "0")}:s${String(j + 1).padStart(2, "0")}`,
        chapter: s.ch.n,
        chapterTitle: s.ch.title,
        section: p.title,
        page: p.page,
        figures: p.figures,
        text: p.text,
      });
    });
});

mkdirSync(dirname(OUT), { recursive: true });
const kb = {
  source: {
    title: "Manual de Usuario — Nortex",
    edition: "Septiembre 2026",
    file: "Manual-de-Usuario-Nortex.pdf",
    sha256,
  },
  chapters,
  segments,
};
writeFileSync(OUT, JSON.stringify(kb, null, 2) + "\n");
console.error(`[build-manual-kb] ${chapters.length} capítulos, ${segments.length} segmentos -> ${OUT}`);
