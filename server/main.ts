// The game server: static files, /healthz, /stats and one WebSocket at /ws.
// Workshop issue #25, technical plan §6, §8.3.
//
// Node 22 runs this .ts unbuilt (type stripping), with `ws` as the only
// dependency. Everything configurable arrives by environment variable:
//
//   PORT        listen port                               (80)
//   WEB_ROOT    directory served as the site               (/app/web)
//   MAX_WS      sockets beyond this get {t:"full"}         (40)
//   LOG_DESYNC  1 = log replay mismatches with user agent  (off)
//   GRACE_MS    reconnect grace period                     (60000)
//   TURN_MS     the test room's decision clock             (20000)
//
// /stats reports every one of these back, alongside the live counts, because
// a deployed value that can only be read over SSH or by triggering it is not
// a value anyone can audit (workshop #37, #44).
//
// The alarm (workshop #39, #18). With no ALERT_SMTP_HOST / ALERT_TO every
// rule still runs and every alert is still written to stdout; only delivery
// is off. Nothing here names a host -- this one is temporary.
//
//   ALERT_SMTP_HOST  relay to post through            (unset = log only)
//   ALERT_SMTP_PORT  587
//   ALERT_SMTP_USER  ALERT_SMTP_PASS   AUTH PLAIN credentials
//   ALERT_FROM       envelope and header sender
//   ALERT_TO         comma-separated recipients       (unset = log only)
//   ALERT_NAME       which deployment this is: staging, production
//   ALERT_POLL_MS    how often the rules run                     (15000)
//   ALERT_WS_WARN    warn at this fraction of MAX_WS             (0.8)
//   ALERT_MEM_MB     cgroup memory alarm, MB                     (0 = off)
//   ALERT_REPEAT_MS  a firing alert re-sends at most this often  (3600000)
//
// MAX_WS is a ceiling on damage to the HOST, not a guess at demand (workshop
// #18). This host's Apache is mpm_prefork with MaxRequestWorkers 150, shared
// with the owner's mail interface and two other sites, and one WebSocket holds
// one whole Apache process: measured 0.88 processes per connection at 50
// connections, 0.78 at 20. At 40 the game can occupy about 35 of the 150, so
// a busy game queues instead of taking unrelated sites down with it. Raise it
// only after the ingress stops being Apache prefork.

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRooms } from "./rooms.ts";
import type { Options } from "./rooms.ts";
import { createAlerter, envConfig } from "./alert.ts";
import { cgroupMemory, createWatch, startWatch } from "./watch.ts";
import type { Snapshot } from "./watch.ts";

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
  let info;
  try { info = await stat(file); } catch { return plain(res, 404, "not found"); }
  if (!info.isFile()) return plain(res, 404, "not found");

  const body = await readFile(file);
  const ext = extname(file).toLowerCase();
  const etag = etagFor(file, info.size, info.mtimeMs, body);
  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
  const headers = {
    "cache-control": cacheControl(path, ext),
    etag,
    "last-modified": lastModified,
  };
  const inm = req.headers["if-none-match"];
  const ims = req.headers["if-modified-since"];
  const fresh = inm !== undefined
    ? inm.split(",").some(t => t.trim().replace(/^W\//, "") === etag || t.trim() === "*")
    : ims !== undefined && Date.parse(ims) >= Date.parse(lastModified);
  if (fresh) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "content-length": body.length,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// Caching. Nothing under web/ has a content hash in its name, and staging
// redeploys on every push, so anything that is code or a page is revalidated
// on every use (a 304 costs a round trip, not the bytes): a cached bundle
// running against a newer server is a confusing bug. The credited assets
// change rarely and are the bulk of the bytes, so they are cached for an hour.
function cacheControl(path: string, ext: string) {
  if (path.startsWith("/assets/")) return "public, max-age=3600";
  if (ext === ".html" || ext === ".js" || ext === ".mjs" || ext === ".css") return "no-cache";
  return "public, max-age=300";
}

// A strong ETag from the content, so an identical rebuild keeps its ETag and
// clients keep their 304s. Hashed once per (file, size, mtime).
const etags = new Map<string, string>();
function etagFor(file: string, size: number, mtimeMs: number, body: Buffer) {
  const key = `${file}\0${size}\0${mtimeMs}`;
  let tag = etags.get(key);
  if (!tag) {
    tag = `"${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
    etags.set(key, tag);
  }
  return tag;
}

function plain(res: ServerResponse, code: number, text: string) {
  res.writeHead(code, { "content-type": "text/plain" });
  res.end(text);
}

export type ServerOptions = Partial<Options> & { port: number; webRoot: string };

export function startServer(o: ServerOptions): Promise<{ port: number; close(): Promise<void>; rooms: ReturnType<typeof createRooms> }> {
  const root = resolve(o.webRoot);
  const rooms = createRooms({
    maxWs: o.maxWs ?? 40, graceMs: o.graceMs ?? 60000, turnMs: o.turnMs ?? 20000,
    pingMs: o.pingMs ?? 25000, logDesync: o.logDesync ?? false, log: o.log ?? console.log,
    computerThinkMs: o.computerThinkMs, keepComputerFrames: o.keepComputerFrames,
    aClockMs: o.aClockMs,
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
    maxWs: Number(env.MAX_WS || 40),
    logDesync: env.LOG_DESYNC === "1",
    graceMs: Number(env.GRACE_MS || 60000),
    turnMs: Number(env.TURN_MS || 20000),
  });
  console.log(`clade server on ${s.port} (MAX_WS=${env.MAX_WS || 40})`);

  // ---- the alarm (workshop #39, #18). See server/alert.ts for why the
  // server alerts on itself rather than being polled from outside.
  const maxWs = Number(env.MAX_WS || 40);
  const alerter = createAlerter(envConfig(env, l => console.log(l)));
  const watch = createWatch(alerter, {
    maxWs,
    warnFraction: Number(env.ALERT_WS_WARN || 0.8),
    memLimitBytes: Number(env.ALERT_MEM_MB || 0) * 1048576,
    memory: cgroupMemory,
    log: l => console.log(l),
  });

  // ONE MAIL PER START, and it is not a courtesy. An expected start is two
  // seconds of the owner's attention; an UNEXPECTED one is a crash report,
  // and a crash LOOP is a stream of them. That is how "the process died" gets
  // a seconds-scale alarm without any external watcher -- which matters,
  // because the only external watcher this project has fires every 2-5 h
  // (#39, measured). Docker restarts the container; the restarted process
  // tells someone it happened.
  await alerter.event(
    "start",
    `server started (MAX_WS=${maxWs}, warn at ${watch.warnAt})`,
    [
      `node       : ${process.version}`,
      `port       : ${s.port}`,
      `MAX_WS     : ${maxWs}`,
      `warn at    : ${watch.warnAt} connections`,
      `poll       : every ${Number(env.ALERT_POLL_MS || 15000)} ms`,
      "",
      "If you did not just deploy, this is a crash report: the container",
      "restarted. Several of these in a row is a crash loop.",
    ].join("\n"),
  );
  startWatch(watch, () => s.rooms.stats() as Snapshot, Number(env.ALERT_POLL_MS || 15000));

  // Last backstop (#34): a bug in one room handler must not end the process
  // and every match with it. Per-socket and per-room catches live in
  // rooms.ts; this catches what escapes a timer or a promise.
  process.on("uncaughtException", e => console.log(`uncaught: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
  process.on("unhandledRejection", e => console.log(`unhandled rejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
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
