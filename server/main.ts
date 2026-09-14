// The game server: static files, /healthz, /stats and one WebSocket at /ws.
// Workshop issue #25, technical plan §6, §8.3.
//
// Node 22 runs this .ts unbuilt (type stripping), with `ws` as the only
// dependency. Everything configurable arrives by environment variable:
//
//   PORT        listen port                               (80)
//   WEB_ROOT    directory served as the site               (/app/web)
//   MAX_WS      sockets beyond this get {t:"full"}         (100)
//   LOG_DESYNC  1 = log replay mismatches with user agent  (off)
//   GRACE_MS    reconnect grace period                     (60000)
//   TURN_MS     the test room's decision clock             (20000)

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRooms } from "./rooms.ts";
import type { Options } from "./rooms.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const isFile = async (p: string) => { try { return (await stat(p)).isFile(); } catch { return false; } };
const isDir = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

// Any file under the web root, subdirectories included. A directory is served
// as its index.html (redirecting to the trailing slash first, so relative URLs
// in the page resolve), and /name falls back to /name.html.
async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return plain(res, 400, "bad request"); }
  if (path.includes("\0")) return plain(res, 400, "bad request");

  let file = resolve(root, "." + path);
  if (file !== root && !file.startsWith(root + sep)) return plain(res, 404, "not found");

  if (await isDir(file)) {
    if (!url.pathname.endsWith("/")) {
      res.writeHead(301, { location: url.pathname + "/" + url.search });
      return res.end();
    }
    file = join(file, "index.html");
  } else if (!(await isFile(file)) && !extname(file) && (await isFile(file + ".html"))) {
    file += ".html";
  }
  if (!(await isFile(file))) return plain(res, 404, "not found");

  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    // Staging redeploys on every push; a cached page against a new server is
    // a confusing bug report. The POC pays the bytes.
    "cache-control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function plain(res: ServerResponse, code: number, text: string) {
  res.writeHead(code, { "content-type": "text/plain" });
  res.end(text);
}

export type ServerOptions = Partial<Options> & { port: number; webRoot: string };

export function startServer(o: ServerOptions): Promise<{ port: number; close(): Promise<void>; rooms: ReturnType<typeof createRooms> }> {
  const root = resolve(o.webRoot);
  const rooms = createRooms({
    maxWs: o.maxWs ?? 100, graceMs: o.graceMs ?? 60000, turnMs: o.turnMs ?? 20000,
    pingMs: o.pingMs ?? 25000, logDesync: o.logDesync ?? false, log: o.log ?? console.log,
    computerThinkMs: o.computerThinkMs, keepComputerFrames: o.keepComputerFrames,
  });

  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    // Byte-identical to the Sprint 1 probe and the nginx placeholder before
    // it: the uptime workflow asserts status 200 and a body of exactly "ok".
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }

    if (pathname === "/stats") {
      const mem = process.memoryUsage();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      return res.end(JSON.stringify({ ...rooms.stats(), rss: mem.rss, heapUsed: mem.heapUsed,
                                      uptime: Math.round(process.uptime()) }));
    }

    if (req.method !== "GET" && req.method !== "HEAD") return plain(res, 405, "method not allowed");
    serveStatic(root, req, res).catch(e => {
      console.log(`static error: ${e.message}`);
      if (!res.headersSent) plain(res, 500, "error");
      else res.destroy();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return socket.destroy();
    rooms.upgrade(req, socket, head);
  });

  return new Promise(ok => server.listen(o.port, () => {
    const addr = server.address();
    ok({
      port: typeof addr === "object" && addr ? addr.port : o.port,
      rooms,
      // Let the WebSocket close handshakes finish before dropping connections,
      // or clients see 1006 instead of 1012 (observed on a docker restart).
      close: async () => {
        await rooms.shutdown();
        await new Promise<void>(done => {
          server.close(() => done());
          server.closeAllConnections();
        });
      },
    });
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const s = await startServer({
    port: Number(env.PORT || 80),
    webRoot: env.WEB_ROOT || "/app/web",
    maxWs: Number(env.MAX_WS || 100),
    logDesync: env.LOG_DESYNC === "1",
    graceMs: Number(env.GRACE_MS || 60000),
    turnMs: Number(env.TURN_MS || 20000),
  });
  console.log(`clade server on ${s.port} (MAX_WS=${env.MAX_WS || 100})`);
  // Docker stops a container with SIGTERM. Tell every client before exiting,
  // so a redeploy reads as "interrupted" rather than as a hang.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      console.log(`${sig}: closing`);
      s.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
