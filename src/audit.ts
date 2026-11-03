/**
 * Auditoría de tool calls (PLAN §5 — governance pedida en la junta).
 *
 * Una línea JSON por llamada, por **stderr** (stdout es SOLO protocolo MCP).
 * Campos: tool, tenant, timestamp ISO, latencia en ms, resultado.
 *
 * NUNCA se registra: el service token, el JWT del cliente (F7: solo sus ids), el token opaco nxt_ (F7.1: solo su SHA-256), los argumentos del call (pueden llevar
 * datos del negocio) ni respuestas del backend. Solo metadatos de la llamada.
 */

export type AuditStatus = "ok" | "error" | "rate_limited";

/** ops = token de operador/stdio (tenant del entorno); client = JWT del cliente (F7). */
export type SessionMode = "ops" | "client";

/** Solo modo cliente: con qué credencial se abrió la sesión (F7.1). */
export type AuthKind = "jwt" | "opaque";

export interface AuditEntry {
  tool: string;
  /** null en sesiones opacas (F7.1): el monolito acota por el token, el MCP no conoce el tenant. */
  tenant: string | null;
  /** Solo modo cliente: id del usuario (claim del JWT). Nunca el token. */
  userId?: string;
  role?: string;
  mode?: SessionMode;
  /** Solo modo cliente: "jwt" | "opaque". */
  authKind?: AuthKind;
  /** Solo sesiones opacas: `opaque:<sha256 hex del token>`. Nunca el token. */
  subject?: string;
  ts: string; // ISO 8601
  latencyMs: number;
  status: AuditStatus;
}

export function auditLog(entry: AuditEntry): void {
  console.error(JSON.stringify({ event: "tool_call", ...entry }));
}

/** Tenant de la sesión para auditoría y rate limit (nunca sale del proceso). */
export function tenantFromEnv(): string {
  return process.env.NORTEX_TENANT_ID ?? "default";
}
