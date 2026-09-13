// A probe, not the game server. Workshop issue #14.
//
// It exists so issues #15 (does a WebSocket survive the Apache -> Traefik
// path) and #16 (what does a connection actually cost) have something real to
// measure. It deliberately has no game logic, no framework, no abstraction and
// exactly one dependency.
//
// The runtime is Node because that is the standing recommendation in the
// architect brief. THIS DOES NOT CHOOSE THE RUNTIME. If the architect picks
// otherwise once the concept exists, this is an hour to redo. Do not build on
// it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 80);
const WEB_ROOT = process.env.WEB_ROOT || '/app/web';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Kept byte-identical to the nginx placeholder: the uptime check in
  // .github/workflows/uptime.yml asserts the body is exactly "ok".
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // Connection count, so #16 can measure without attaching a debugger.
  if (url.pathname === '/stats') {
    const mem = process.memoryUsage();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      connections: wss.clients.size,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      uptime: Math.round(process.uptime()),
    }));
  }

  // Static files. normalize() before joining, or `..` escapes WEB_ROOT.
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname)
    .replace(/^(\.\.[/\\])+/, '');
  const file = join(WEB_ROOT, rel);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

// noServer + manual upgrade, so a failed upgrade is visible in the log rather
// than silently dropped. Issue #15 is specifically about whether the upgrade
// survives two proxy hops, and a silent failure there would be the worst case.
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  console.log(`upgrade requested: ${pathname} ` +
              `connection=${req.headers.connection} upgrade=${req.headers.upgrade}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const id = Math.random().toString(36).slice(2, 8);
  console.log(`ws open ${id} (${wss.clients.size} total)`);
  ws.send(JSON.stringify({ type: 'welcome', id, serverTime: Date.now() }));

  ws.on('message', data => {
    // Echo with a server timestamp. #16 measures round-trip from this.
    let payload;
    try { payload = JSON.parse(data); } catch { payload = { raw: String(data) }; }
    ws.send(JSON.stringify({ type: 'echo', id, serverTime: Date.now(), payload }));
  });

  ws.on('close', (code, reason) => {
    // The close code is the evidence for #15's idle-timeout question: a proxy
    // killing an idle connection looks different from a clean client close.
    console.log(`ws close ${id} code=${code} reason="${reason}" ` +
                `(${wss.clients.size} remain)`);
  });
  ws.on('error', e => console.log(`ws error ${id}: ${e.message}`));
});

server.listen(PORT, () => console.log(`probe listening on ${PORT}`));
