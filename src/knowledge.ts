/**
 * F6 — Base de conocimiento de USO de Nortex + recuperación full-text local.
 *
 * Fuentes (solo oficiales, versionadas en `knowledge/`):
 * - `manual.json`: Manual de Usuario PDF segmentado por capítulo/subsección
 *   (lo genera `scripts/build-manual-kb.mjs`).
 * - `casos.json`: casos reales verificados contra el código del monolito.
 *
 * Recuperación: BM25 implementado acá, sin dependencias ni APIs externas.
 * Regla de oro: la respuesta es EXTRACTIVA (texto del manual o del caso, nunca
 * generado). Si la cobertura de la pregunta es baja, se devuelve "sin
 * fundamento" en vez de adivinar. Esta tool no toca datos del tenant.
 */
import { readFileSync } from "node:fs";

// ---- Tipos de las fuentes ----
export interface ManualSegment {
  id: string;
  chapter: number;
  chapterTitle: string;
  section: string | null;
  page: number;
  figures: { n: number; caption: string }[];
  text: string;
}

export interface ManualKb {
  source: { title: string; edition: string; file: string; sha256: string };
  segments: ManualSegment[];
}

export interface CasoVerificado {
  id: string;
  titulo: string;
  preguntas: string[];
  keywords: string[];
  respuesta: string;
  limitacionConocida?: boolean;
  verificacion: { fecha: string; archivos: string[]; nota?: string };
}

export interface CasosKb {
  verificadoContra: string;
  casos: CasoVerificado[];
}

export interface KnowledgeDoc {
  id: string;
  kind: "manual" | "caso";
  /** Etiqueta legible de la fuente (capítulo/figura o caso). */
  fuente: string;
  /** Texto que se devuelve como respuesta (extractivo). */
  answer: string;
  /** Tokens indexados (título con peso doble). */
  tokens: string[];
}

export type Confianza = "alta" | "media";

export interface Hit {
  doc: KnowledgeDoc;
  score: number;
  /** Términos de la pregunta presentes en el documento. */
  matched: string[];
}

export interface ResolveResult {
  status: "ok" | "sin_fundamento";
  confianza?: Confianza;
  top?: Hit;
  related: Hit[];
  /** Términos informativos de la pregunta (después de stopwords/stemming). */
  queryTerms: string[];
  coverage: number;
}

// ---- Texto: normalización, stopwords, stemming liviano en español ----
const STOPWORDS = new Set(
  (
    "a al algo algun alguna alguno ante antes aqui asi bien cada como con contra cual cuales cuando cuanto de del desde donde " +
    "durante e el ella ellas ellos en entre era es esa ese eso esta este esto estoy fue ha hace hacer hacerlo hago han hay " +
    "la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o otra otro otros para pero poco por porque puede " +
    "pueden puedo que quien quiero se sea segun ser si sin sobre solo son su sus tambien tan tanto te tengo tenes tiene " +
    "todo todos tu tus un una uno unos unas usted y ya yo vos sos podes queres como hacemos necesito nortex sistema app " +
    "favor hola gracias ayuda ayudame decime dime explicame forma manera alguien deberia debo tenia algun"
  ).split(/\s+/),
);

const SUFFIXES = [
  "imientos", "imiento", "amientos", "amiento", "aciones", "iciones", "acion", "icion", "ucion", "mente", "idades",
  "idad", "ando", "iendo", "adas", "ados", "idas", "idos", "ada", "ado", "ida", "ido", "aste", "aron", "amos", "emos",
  "ar", "er", "ir", "es", "as", "os", "is", "a", "e", "o", "s",
];
const MIN_STEM = 3;
/**
 * Raíces que se unifican en índice Y pregunta (venta/vender/vendo, fío/fiado,
 * cobrar/pagar). Solo raíces irregulares o sinónimos de uso diario; no es un
 * tesauro: lo que no está acá tiene que estar en el texto de la fuente.
 */
const STEM_ALIAS: Record<string, string> = {
  vent: "vend",
  fio: "fiad",
  fiar: "fiad",
  fias: "fiad",
  cobr: "pag",
};

export function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function stem(word: string): string {
  let s = word;
  for (const suf of SUFFIXES) {
    if (s.endsWith(suf) && s.length - suf.length >= MIN_STEM) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  return STEM_ALIAS[s] ?? s;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const w of normalize(text).split(/[^a-z0-9]+/)) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

// ---- Construcción del corpus ----
function manualFuente(s: ManualSegment): string {
  let label = `Manual, cap. ${s.chapter} «${s.chapterTitle}»`;
  if (s.section) label += ` › ${s.section}`;
  const figs = s.figures.map((f) => `Figura ${f.n}`);
  if (figs.length) label += ` (${figs.join(", ")})`;
  return `${label}, p. ${s.page}`;
}

/** Recorta en límite de párrafo/oración para una respuesta breve. */
export function brief(text: string, max = 700): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return (at > max * 0.4 ? cut.slice(0, at + 1) : cut).trimEnd() + " …";
}

export function buildDocs(manual: ManualKb, casos: CasosKb): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = [];
  for (const s of manual.segments) {
    const title = [s.chapterTitle, s.section ?? ""].join(" ");
    const captions = s.figures.map((f) => f.caption).join(" ");
    docs.push({
      id: s.id,
      kind: "manual",
      fuente: manualFuente(s),
      answer: brief(s.text),
      tokens: [...tokenize(title), ...tokenize(title), ...tokenize(s.text), ...tokenize(captions)],
    });
  }
  for (const c of casos.casos) {
    docs.push({
      id: `caso:${c.id}`,
      kind: "caso",
      fuente: `Caso verificado «${c.titulo}» (verificado contra el código, ${c.verificacion.fecha})`,
      answer: c.respuesta,
      tokens: [
        ...tokenize(c.titulo),
        ...tokenize(c.titulo),
        ...tokenize(c.preguntas.join(" ")),
        ...tokenize(c.keywords.join(" ")),
        ...tokenize(c.respuesta),
      ],
    });
  }
  return docs;
}

// ---- BM25 ----
export class Bm25Index {
  private readonly tf: Map<string, number>[];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;

  constructor(
    readonly docs: KnowledgeDoc[],
    private readonly k1 = 1.2,
    private readonly b = 0.5,
  ) {
    this.tf = docs.map((d) => {
      const m = new Map<string, number>();
      for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
      for (const t of m.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return m;
    });
    this.avgLen = docs.reduce((a, d) => a + d.tokens.length, 0) / Math.max(1, docs.length);
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }

  search(terms: string[]): Hit[] {
    const hits: Hit[] = [];
    this.docs.forEach((doc, i) => {
      const tf = this.tf[i]!;
      let score = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const f = tf.get(t);
        if (!f) continue;
        matched.push(t);
        const norm = f + this.k1 * (1 - this.b + (this.b * doc.tokens.length) / this.avgLen);
        score += this.idf(t) * ((f * (this.k1 + 1)) / norm);
      }
      if (score > 0) hits.push({ doc, score, matched });
    });
    return hits.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
  }
}

// ---- Decisión (fail-closed) ----
/** Cobertura mínima de los términos de la pregunta en la fuente elegida. */
export const COVERAGE_ALTA = 0.75;
export const COVERAGE_MEDIA = 0.6;
/** Un "ver también" solo si puntúa al menos esta fracción del primero. */
const RELATED_RATIO = 0.6;

export function resolve(index: Bm25Index, pregunta: string): ResolveResult {
  const queryTerms = [...new Set(tokenize(pregunta))];
  const none: ResolveResult = { status: "sin_fundamento", related: [], queryTerms, coverage: 0 };
  if (queryTerms.length === 0) return none;
  const hits = index.search(queryTerms);
  const top = hits[0];
  if (!top) return none;
  const coverage = top.matched.length / queryTerms.length;
  const minMatched = Math.min(2, queryTerms.length);
  if (top.matched.length < minMatched || coverage < COVERAGE_MEDIA) {
    return { ...none, coverage };
  }
  const related = hits
    .slice(1)
    .filter((h) => h.score >= top.score * RELATED_RATIO && h.matched.length >= minMatched)
    .slice(0, 2);
  return {
    status: "ok",
    // Con un solo término informativo no hay evidencia para "alta".
    confianza: coverage >= COVERAGE_ALTA && queryTerms.length >= 2 ? "alta" : "media",
    top,
    related,
    queryTerms,
    coverage,
  };
}

// ---- Carga (una vez por proceso) ----
const KB_DIR = new URL("../knowledge/", import.meta.url);
let cached: Bm25Index | null = null;

export function loadIndex(): Bm25Index {
  if (cached) return cached;
  const manual = JSON.parse(readFileSync(new URL("manual.json", KB_DIR), "utf8")) as ManualKb;
  const casos = JSON.parse(readFileSync(new URL("casos.json", KB_DIR), "utf8")) as CasosKb;
  if (!Array.isArray(manual.segments) || manual.segments.length === 0) throw new Error("manual.json vacío");
  if (!Array.isArray(casos.casos)) throw new Error("casos.json inválido");
  cached = new Bm25Index(buildDocs(manual, casos));
  return cached;
}
