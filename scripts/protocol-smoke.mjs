/**
 * Smoke de protocolo MCP (2026-10-14; F5 2026-10-15; F6 2026-10-17): cliente real del SDK
 * sobre stdio contra `node dist/index.js` en modo mock. Hace el handshake
 * (initialize), lista las tools con sus schemas y las llama. La transcripción queda en
 * protocol-smoke-output.txt como evidencia. Uso: npm run build && node scripts/protocol-smoke.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const lines = [];
const log = (s) => {
  lines.push(s);
  console.log(s);
};

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, NORTEX_API_MODE: "mock" },
  stderr: "pipe",
});
const auditLines = [];
transport.stderr?.on("data", (d) => {
  for (const l of String(d).split("\n")) if (l.trim()) auditLines.push(l);
});

const client = new Client({ name: "nortex-mcp-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
log(`HANDSHAKE OK: server=${client.getServerVersion()?.name} v${client.getServerVersion()?.version}`);

const { tools } = await client.listTools();
log(`TOOLS/LIST: ${tools.length} tools`);
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  log(`  - ${t.name} (params: ${props.length ? props.join(", ") : "—"}) required=${JSON.stringify(t.inputSchema?.required ?? [])}`);
}

const calls = [
  ["ventas_hoy", {}],
  ["ventas_periodo", { dias: 7 }],
  ["buscar_producto", { q: "queso", limit: 10 }],
  ["stock_producto", { producto: "queso frito" }],
  ["inventario_bajo", {}],
  ["estado_conteo", {}],
  ["estado_conteo", { bodega: "principal" }],
  ["precio_producto", { producto: "queso frito" }],
  ["detalle_venta", { factura: "A-001234" }],
  ["informe_ventas", { periodo: "mes" }],
  ["informe_ventas", { periodo: "semana" }],
  ["informe_ventas", { desde: "2026-10-01", hasta: "2026-10-15" }],
  ["informe_ventas", { desde: "2026-09-01", hasta: "2026-10-15" }],
  // F6: banco de pruebas del brief (dudas de uso)
  ["resolver_duda", { pregunta: "¿Puedo vender el mismo producto por caja y por unidad?" }],
  ["resolver_duda", { pregunta: "La caja trae un código de barras y la unidad otro, ¿cómo hago?" }],
  ["resolver_duda", { pregunta: "¿Cómo registro regalías?" }],
  ["resolver_duda", { pregunta: "El POS me rechaza una venta de carne con lotes" }],
  ["resolver_duda", { pregunta: "¿Cómo conecto Nortex con mi tienda de Shopify?" }],
];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.map((c) => c.text ?? "").join("\n");
  log(`CALL ${name} ${JSON.stringify(args)}\n  -> ${text}`);
}

await client.close();
log(`AUDIT (stderr, ${auditLines.length} líneas):`);
for (const l of auditLines) log(`  ${l}`);
writeFileSync(new URL("./protocol-smoke-output.txt", import.meta.url), lines.join("\n") + "\n");
log("SMOKE COMPLETO");
