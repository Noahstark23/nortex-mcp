/**
 * Cliente HTTP inyectable hacia el backend de Nortex.
 *
 * - La interfaz `NortexApi` es lo que las tools consumen: en F1 se inyecta el
 *   mock (`src/mock.ts`); en F3 se inyectará `createHttpNortexApi`.
 * - El service token SIEMPRE llega por variable de entorno (NORTEX_SERVICE_TOKEN),
 *   leído una sola vez en `src/index.ts`. Nunca se loguea, nunca va en el repo.
 * - 401/403 -> NortexAuthError -> las tools responden fail-closed con mensaje
 *   en voseo, CERO datos del negocio (ni del tenant propio ni de otro).
 */

export class NortexApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "NortexApiError";
    this.status = status;
  }
}

/** 401/403: sesión inválida, revocada o de otro tenant. Fail closed. */
export class NortexAuthError extends NortexApiError {
  constructor() {
    super(401, "nortex: auth rechazada (401/403)");
    this.name = "NortexAuthError";
  }
}

export interface NortexApi {
  /** GET autenticado contra el backend. Lanza NortexApiError / NortexAuthError. */
  get<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T>;
}

/**
 * Algunos endpoints del backend envuelven la respuesta en `{ success: true, data }`
 * (verificado contra el código del monolito 2026-10-14:
 * `GET /api/warehouses/product/:id/stock`, backend/routes/warehouses.ts).
 * Se desenvuelve SOLO ese patrón exacto; cualquier otra forma pasa intacta
 * (el reporte de ventas, la página de productos y la lista de conteos no traen
 * envoltura).
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { success?: unknown }).success === true &&
    "data" in body
  ) {
    return (body as { data: unknown }).data;
  }
  return body;
}

export function createHttpNortexApi(opts: { baseUrl: string; token: string }): NortexApi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
      const url = new URL(path, `${base}/`);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
      // El token solo viaja en el header Authorization; jamás en logs ni URLs.
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${opts.token}` },
      });
      if (res.status === 401 || res.status === 403) throw new NortexAuthError();
      if (!res.ok) throw new NortexApiError(res.status, `nortex: HTTP ${res.status} en ${path}`);
      return unwrapEnvelope(await res.json()) as T;
    },
  };
}
