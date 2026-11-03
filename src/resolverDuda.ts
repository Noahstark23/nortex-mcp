/**
 * F6 — Tool `resolver_duda`: responde dudas de USO de Nortex ("¿cómo vendo por
 * caja y por unidad?") con fuentes oficiales: el Manual de Usuario y los casos
 * verificados contra el código (ver knowledge.ts).
 *
 * Governance:
 * - Solo conocimiento: no recibe ToolCtx/api, no lee ni escribe datos del tenant.
 * - Respuesta extractiva + fuente + confianza. Sin fuente que respalde ->
 *   MSG_SIN_FUNDAMENTO, nunca pasos inventados.
 * - Fail closed: si la base no carga, mensaje en voseo y cero contenido.
 */
import { z } from "zod";
import { loadIndex, resolve, type Bm25Index } from "./knowledge.js";

export const MSG_PREGUNTA_MIN = "Contame tu duda con un poco más de detalle (mínimo 5 letras).";
export const MSG_PREGUNTA_MAX = "Tu pregunta es muy larga. Resumila en hasta 500 letras.";
export const MSG_SIN_FUNDAMENTO =
  "Sin fundamento en el manual: no encontré una fuente oficial de Nortex que responda eso, así que no te invento pasos. Probá preguntarlo con otras palabras o consultalo con el equipo de Nortex.";
export const MSG_KB_NO_DISPONIBLE =
  "No pude consultar la base de conocimiento de Nortex. Probá de nuevo en un rato.";

const DudaArgs = z.object({
  pregunta: z.string().trim().min(5).max(500),
});

const CONFIANZA_TXT = { alta: "alta", media: "media (revisá que la fuente sea lo que buscás)" } as const;

/** `loader` inyectable para tests (fail-closed). */
export function resolverDuda(args: unknown, loader: () => Bm25Index = loadIndex): string {
  const parsed = DudaArgs.safeParse(args ?? {});
  if (!parsed.success) {
    const big = parsed.error.issues.some((i) => i.code === "too_big");
    return big ? MSG_PREGUNTA_MAX : MSG_PREGUNTA_MIN;
  }
  let index: Bm25Index;
  try {
    index = loader();
  } catch {
    return MSG_KB_NO_DISPONIBLE;
  }
  const r = resolve(index, parsed.data.pregunta);
  if (r.status !== "ok" || !r.top || !r.confianza) return MSG_SIN_FUNDAMENTO;

  const lines = [r.top.doc.answer, "", `Fuente: ${r.top.doc.fuente}`];
  if (r.related.length) lines.push(`Ver también: ${r.related.map((h) => h.doc.fuente).join(" · ")}`);
  lines.push(`Confianza: ${CONFIANZA_TXT[r.confianza]}`);
  return lines.join("\n");
}
