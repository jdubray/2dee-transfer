import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";

const cfg = loadConfig();
const app = createApp(cfg);

function clientIp(req: Request, direct: string | undefined): string {
  if (cfg.trustProxy) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf;
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  return direct ?? "unknown";
}

const server = Bun.serve({
  hostname: cfg.host,
  port: cfg.port,
  // One upload chunk plus slack. Whole files never travel in one request.
  maxRequestBodySize: cfg.chunkBytes + 1024 * 1024,
  idleTimeout: 120,
  async fetch(req, srv) {
    const started = performance.now();
    const res = await app.fetch(req, clientIp(req, srv.requestIP(req)?.address));
    if (cfg.requestLog) {
      const url = new URL(req.url);
      const ms = (performance.now() - started).toFixed(0);
      console.log(`[transfer] ${req.method} ${url.pathname} ${res.status} ${ms}ms`);
    }
    return res;
  },
});

app.sweep();
const timer = setInterval(() => app.sweep(), 10 * 60 * 1000);

console.log(`[transfer] listening on http://${server.hostname}:${server.port} (public: ${cfg.publicOrigin})`);
console.log(`[transfer] data in ${cfg.dataDir}; max file ${cfg.maxFileBytes} bytes; chunk ${cfg.chunkBytes} bytes`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    server.stop();
    app.close();
    process.exit(0);
  });
}
