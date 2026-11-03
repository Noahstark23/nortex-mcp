/**
 * nortex-mcp — servidor MCP, 8 tools read-only en voseo.
 *
 * Transporte por entorno: stdio (default) o Streamable HTTP con
 * MCP_TRANSPORT=http (ver http.ts). La construcción del servidor y la
 * governance viven en server.ts (idénticas para ambos transportes).
 *
 * El backend es mock por default (datos sintéticos, SIN VERIFICAR CONTRA
 * STAGING); NORTEX_API_MODE=http lo apunta al backend real. El token real
 * (NORTEX_SERVICE_TOKEN) solo se lee del entorno; jamás se imprime. En stdio,
 * stdout es SOLO protocolo MCP (logs y auditoría van a stderr).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RateLimiter, rateLimitFromEnv } from "./rateLimit.js";
import { tenantFromEnv } from "./audit.js";
import { apiFromEnv, createNortexMcpServer } from "./server.js";
import { startHttpFromEnv } from "./http.js";

async function main(): Promise<void> {
  if ((process.env.MCP_TRANSPORT ?? "stdio").toLowerCase() === "http") {
    await startHttpFromEnv();
    return;
  }
  const server = createNortexMcpServer({
    api: apiFromEnv(),
    tenant: tenantFromEnv(),
    rateLimiter: new RateLimiter(rateLimitFromEnv()),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  // stderr: stdout es solo protocolo. Nunca imprimir el token.
  console.error("[nortex-mcp] error fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
