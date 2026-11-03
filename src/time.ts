/**
 * "Hoy" = día comercial America/Managua (UTC-6, sin DST), no UTC.
 * (Skill nortex-mcp §7: olvidar la zona horaria es un pitfall clásico.)
 */

/** Devuelve YYYY-MM-DD del día civil en America/Managua. */
export function todayManagua(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Managua",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Resta n días civiles a una fecha YYYY-MM-DD (aritmética en civil Managua). */
export function minusDaysManagua(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  // Mediodía UTC = mañana en Managua (UTC-6): nunca cambia de día civil.
  return todayManagua(new Date(Date.UTC(y, m - 1, d, 12, 0, 0) - n * 86400000));
}

/** true si `s` tiene forma YYYY-MM-DD y es una fecha civil real. */
export function isValidDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Días civiles de `a` a `b` (b - a); negativo si b < a. Ambas YYYY-MM-DD. */
export function daysBetweenManagua(a: string, b: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86400000);
}

/** "2026-10-08" -> "jueves" (nombre largo en español, minúsculas). */
export function weekdayNameManagua(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("es-NI", {
    timeZone: "America/Managua",
    weekday: "long",
  }).format(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)));
}
