// What the alarm watches. Workshop #39, #18.
//
// The rules are separated from the polling and from the delivery so they can
// be tested without a timer and without a relay. `tick()` is the whole of the
// behaviour; `startWatch()` is just a `setInterval` around it.
//
// WHY POLLING AND NOT A HOOK IN rooms.ts. The refusal branch in
// `server/rooms.ts` is the obvious place to raise "the cap is being hit". A
// poll of `rooms.stats()` gives the same alarm without coupling the alarm to
// that branch, so it keeps working if the refusal path is rewritten.
//
// `refused` (workshop #44) is read when present. Without it the ceiling is an
// exact proxy: a socket can only be refused once connections reach maxWs.

import { readFile } from "node:fs/promises";
import type { Alerter } from "./alert.ts";

export type Snapshot = {
  connections: number;
  refused?: number;
  rooms?: number;
  sessions?: number;
};

export type WatchOptions = {
  maxWs: number;
  warnFraction: number;   // ALERT_WS_WARN, default 0.8
  memLimitBytes: number;  // ALERT_MEM_MB, 0 = off
  memory?: () => Promise<number | null>;
  log: (line: string) => void;
};

export function createWatch(alerter: Alerter, o: WatchOptions) {
  const warnAt = Math.max(1, Math.ceil(o.maxWs * o.warnFraction));
  let lastRefused: number | null = null;

  return {
    warnAt,
    async tick(s: Snapshot) {
      // ---- the cap (#18). Someone must find out that players are being
      // turned away, and "approached" has to fire before "hit", because by
      // the time it is hit the damage is already visible to players.
      //
      // Two keys, not one. With a single key, "approaching" at 32 held the
      // alert open, so reaching 40 inside the repeat window was throttled and
      // nobody was told the cap had actually been hit. "approaching" is only
      // raised on the way up: a jump straight to the ceiling is one mail
      // (REACHED), not two.
      const full = s.connections >= o.maxWs;
      const near = s.connections >= warnAt;
      const nearOn = near && !(full && !alerter.firing("capacity"));
      const body = [
        `connections : ${s.connections}`,
        `MAX_WS      : ${o.maxWs}`,
        `warn at     : ${warnAt}`,
        s.refused === undefined ? "refused     : (not reported)" : `refused     : ${s.refused}`,
        s.rooms === undefined ? "" : `rooms       : ${s.rooms}`,
        s.sessions === undefined ? "" : `sessions    : ${s.sessions}`,
        "",
        "MAX_WS is a ceiling on damage to the HOST, not a guess at demand:",
        "one WebSocket holds one Apache prefork worker of 150 shared with",
        "unrelated sites (workshop #18). Sockets past the cap get",
        '{"t":"full"} and close 1013 -- players see a full server, the host',
        "keeps working. Raise it only after the ingress stops being prefork.",
      ].filter(Boolean).join("\n");
      await alerter.state("capacity", nearOn,
        `connection cap approaching: ${s.connections}/${o.maxWs}`, body);
      await alerter.state("capacity-full", full,
        `connection cap REACHED: ${s.connections}/${o.maxWs}`, body);

      // ---- refusals. A rising counter is the only positive proof that real
      // players were turned away, as opposed to nearly turned away.
      if (typeof s.refused === "number") {
        if (lastRefused !== null && s.refused > lastRefused) {
          await alerter.event(
            "refused",
            `sockets refused: ${s.refused - lastRefused} more (${s.refused} since start)`,
            `connections ${s.connections}/${o.maxWs}. Players were turned away.`,
          );
        }
        // A counter that went backwards means the process restarted.
        lastRefused = s.refused;
      }

      // ---- memory. The box has ~2 GB free and NO SWAP, so a spike is not
      // paged, it is killed -- and the box also holds the owner's mail. The
      // cgroup figure is used, not process.rss: they disagree by 4.5x and the
      // cgroup one is what an OOM kill is based on (notes/reference/host.md).
      if (o.memLimitBytes > 0 && o.memory) {
        const bytes = await o.memory();
        if (bytes !== null) {
          await alerter.state(
            "memory",
            bytes > o.memLimitBytes,
            `memory ${(bytes / 1048576).toFixed(1)} MB over ${(o.memLimitBytes / 1048576).toFixed(0)} MB`,
            `cgroup memory.current ${bytes} bytes. There is no swap on this host:\n` +
            "over the limit the kernel kills, it does not page.",
          );
        }
      }
    },
  };
}

// cgroup v2 first, v1 as a fallback. Both paths are inside the container, so
// nothing here is specific to any host. null when neither exists (a developer
// running the server outside a container).
export async function cgroupMemory(): Promise<number | null> {
  for (const p of ["/sys/fs/cgroup/memory.current",
                   "/sys/fs/cgroup/memory/memory.usage_in_bytes"]) {
    try {
      const n = Number((await readFile(p, "utf8")).trim());
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* not this one */ }
  }
  return null;
}

export function startWatch(
  watch: { tick(s: Snapshot): Promise<void> },
  snapshot: () => Snapshot,
  everyMs: number,
) {
  const timer = setInterval(() => {
    watch.tick(snapshot()).catch(() => { /* an alarm never takes the server down */ });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
