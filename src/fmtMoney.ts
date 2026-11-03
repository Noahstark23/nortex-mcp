/**
 * Formateo centralizado de dinero y cantidades para voz.
 * ÚNICO lugar donde se formatea dinero: el servidor formatea, el modelo narra.
 * Nunca exponer valores sin formatear ni dejar que el modelo haga aritmética.
 */

/** "12450.00" | 12450 -> "C$12,450.00". Acepta string (el backend devuelve strings decimales) o number. */
export function fmtMoney(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error("fmtMoney: valor no numérico");
  }
  const sign = n < 0 ? "-" : "";
  const rounded = Math.round(Math.abs(n) * 100); // centavos, evita errores de float
  const intPart = Math.floor(rounded / 100);
  const cents = rounded % 100;
  const grouped = intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}C$${grouped}.${String(cents).padStart(2, "0")}`;
}

/**
 * Dinero para VOZ (contrato T6 §4.1.3 + §4.3): redondea a la unidad, sin
 * centavos — "C$18,450"; en USD "$48 dólares". Los centavos solo se leen al
 * confirmar una transacción, nunca en una lectura.
 */
export function fmtVoiceMoney(value: string | number, moneda: "NIO" | "USD" = "NIO"): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error("fmtVoiceMoney: valor no numérico");
  }
  const sign = n < 0 ? "-" : "";
  const units = Math.round(Math.abs(n));
  const grouped = units.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return moneda === "USD" ? `${sign}$${grouped} dólares` : `${sign}C$${grouped}`;
}

/** "19.0000" -> "19"; "4.5000" -> "4.5". El stock del backend llega como string toFixed(4). */
export function fmtQty(value: string | number): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) {
    throw new Error("fmtQty: valor no numérico");
  }
  return String(n);
}

/** Plural nicaragüense simple: "libra"->"libras", "caja"->"cajas". 1 -> singular. */
export function pluralUnit(unit: string, qty: string | number): string {
  const n = typeof qty === "string" ? Number(qty) : qty;
  const u = unit.trim();
  if (n === 1) return u;
  const last = u.slice(-1).toLowerCase();
  if ("aeiou".includes(last)) return `${u}s`;
  return `${u}es`;
}

/** "15 en Principal", "4 en Sucursal" -> "15 en Principal y 4 en Sucursal" */
export function joinList(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} y ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} y ${parts[parts.length - 1]}`;
}
