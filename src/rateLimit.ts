/**
 * Rate limit por sesión/tenant (PLAN §5 — governance pedida en la junta).
 *
 * Ventana fija deslizante de 60 s por clave (normalmente el tenant de la
 * sesión; en stdio hay un tenant por proceso). El límite se configura con
 * `NORTEX_RATE_LIMIT_PER_MIN` (default 30). Al excederlo la tool responde
 * con MSG_RATE_LIMIT en voseo, sin tocar el backend.
 *
 * 30 llamadas/min es holgado para voz (una consulta de voz ≈ 1-3 calls) y
 * frena bucles accidentales del modelo antes de golpear el backend.
 */

/** Límite default: 30 tool calls por minuto por tenant/sesión. */
export const DEFAULT_RATE_LIMIT_PER_MIN = 30;

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxPerMinute) || maxPerMinute < 1) {
      throw new Error("RateLimiter: maxPerMinute debe ser un entero positivo");
    }
  }

  /** true si la llamada pasa; false si excede el límite (no registra el hit). */
  allow(key: string): boolean {
    const t = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((ts) => ts > t - 60_000);
    if (fresh.length >= this.maxPerMinute) {
      this.hits.set(key, fresh); // poda entradas vencidas
      return false;
    }
    fresh.push(t);
    this.hits.set(key, fresh);
    return true;
  }
}

/** Lee el límite del entorno, con fallback al default si es inválido. */
export function rateLimitFromEnv(): number {
  const raw = Number(process.env.NORTEX_RATE_LIMIT_PER_MIN);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_RATE_LIMIT_PER_MIN;
}
