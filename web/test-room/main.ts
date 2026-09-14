// The test room's browser client. Workshop issue #25. Not a game: it exists so
// bin/browser/players.mjs can drive real browsers through a full match.
//
// Identity and the run live in localStorage. The run is (runSeed, decisions);
// the herd is derived from it with core/, and the server replays the same log.

import { label } from "../../core/index.ts";
import { replay, autoDecisions, fromHex } from "../../server/testroom/run.ts";
import { matchHash } from "../../server/testroom/room.ts";

const $ = (id: string) => document.getElementById(id)!;
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const rand32 = () => crypto.getRandomValues(new Uint32Array(1))[0];

const id = store.get("clade.id") ?? (() => {
  const v = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
  store.set("clade.id", v);
  return v;
})();
const run = (() => {
  try { const r = JSON.parse(store.get("clade.testroom.run") ?? ""); if (Number.isInteger(r.runSeed)) return r; } catch { /* new run */ }
  const r = { runSeed: rand32(), decisions: autoDecisions() };
  store.set("clade.testroom.run", JSON.stringify(r));
  return r;
})();
const ROOM_KEY = "clade.testroom.room";

let ws: WebSocket | null = null;
let want: "computer" | "person" | null = null;
let side = 0, seed = 0, round = -1, deadline: number | null = null, committed = false;
let reveals: { picks: number[]; hp: number[] }[] = [];
let retry = 0;

const phase = (p: string) => { document.body.dataset.phase = p; };
const status = (s: string) => { $("status").textContent = s; };
const log = (s: string) => { $("log").textContent = s + "\n" + $("log").textContent; };
const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => { retry = 0; send({ t: "hello", v: 1, id, name: `player ${id.slice(0, 4)}`, variant: "test" }); };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = e => {
    ws = null;
    if (store.get(ROOM_KEY)) {
      // In a match: reconnect. Whether the match survived is the server's
      // answer in `welcome`, not a guess made here.
      phase("reconnecting");
      status(`connection lost (${e.code}) — reconnecting…`);
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    } else if (document.body.dataset.phase !== "result") {
      phase("menu");
      status(e.code === 1013 ? "server full — try again later" : "idle");
      $("menu").hidden = false;
    }
  };
}

function onMessage(m: any) {
  switch (m.t) {
    case "full": return status("server full — try again later");
    case "welcome": {
      const was = store.get(ROOM_KEY);
      if (was && m.room !== was) {
        store.del(ROOM_KEY);
        phase("interrupted");
        $("interrupted").hidden = false;
        $("interrupted").textContent = "Match interrupted: the server restarted and the match could not be resumed.";
        $("match").hidden = true;
        $("menu").hidden = false;
        status("idle");
        ws?.close(1000, "interrupted");
        return;
      }
      if (want && !m.room) {
        const r = replay(run.runSeed, run.decisions);
        send({ t: "enter", runSeed: run.runSeed, decisions: run.decisions, stateHash: r.hash });
      }
      return;
    }
    case "accepted": return accepted(m);
    case "matched": {
      side = m.side; seed = m.seed;
      store.set(ROOM_KEY, m.room);
      $("menu").hidden = true;
      $("match").hidden = false;
      $("opponent").textContent = `against ${m.opponent.name}${m.opponent.computer ? " (computer)" : ""} · seed ${m.seed}`;
      return send({ t: "act", do: "sync" });
    }
    case "result": {
      const mine = matchHash(seed, reveals);
      const verdict = mine === m.hash ? "verified" : `MISMATCH (local ${mine})`;
      const outcome = m.winner === null ? "draw" : m.winner === side ? "you won" : "you lost";
      $("result").hidden = false;
      $("result").textContent = `result: ${outcome} ${m.wins[side]}–${m.wins[1 - side]} · hash ${m.hash} ${verdict}`;
      store.del(ROOM_KEY);
      phase("result");
      status("match over");
      deadline = null;
      ws?.close(1000, "match over");
      return;
    }
    case "error": {
      log(`error: ${m.reason}`);
      if (m.reason === "restarting") status("the server is restarting…");
      return;
    }
  }
}

function accepted(m: any) {
  switch (m.do) {
    case "enter": return send({ t: "queue", level: 0, vs: want });
    case "queued": phase("queued"); return status(m.vs === "computer" ? "seating the computer…" : "waiting for a person…");
    case "round": return showRound(m.round, m.deadline, m.options, null, false);
    case "sync":
      reveals = m.history.map((h: any) => ({ picks: h.picks, hp: h.hp }));
      $("wins").textContent = `${m.wins[side]} – ${m.wins[1 - side]}`;
      if (!m.done) showRound(m.round, m.deadline, m.options, m.myCommit, m.opponentCommitted);
      return;
    case "commit": committed = true; phase("committed"); return status("chosen — waiting for the reveal");
    case "opponentCommitted": return $("opponent").dataset.committed = "1", log(`round ${m.round + 1}: opponent has chosen`);
    case "reveal": {
      reveals.push({ picks: m.picks, hp: m.hp });
      $("wins").textContent = `${m.wins[side]} – ${m.wins[1 - side]}`;
      const who = m.winner === null ? "draw" : m.winner === side ? "you won" : "they won";
      log(`round ${m.round + 1}: you ${m.picks[side]}${m.timedOut[side] ? " (timed out)" : ""}, ` +
          `they ${m.picks[1 - side]}${m.timedOut[1 - side] ? " (timed out)" : ""} — ${who} in ${m.ticks} ticks`);
      return;
    }
  }
}

function showRound(r: number, dl: number | null, options: string[][], myCommit: number | null, oppCommitted: boolean) {
  round = r; deadline = dl; committed = myCommit !== null;
  $("round").textContent = `${r + 1}`;
  const mine = $("options");
  mine.textContent = "";
  options[side].forEach((h, i) => {
    const b = document.createElement("button");
    b.className = "pick"; b.dataset.i = String(i);
    b.textContent = `${i}: ${label(fromHex(h)!)}${i === options[side].length - 1 ? " (young)" : ""}`;
    b.disabled = committed;
    if (myCommit === i) b.classList.add("chosen");
    b.onclick = () => {
      if (committed) return;
      committed = true;
      mine.querySelectorAll("button").forEach(x => { (x as HTMLButtonElement).disabled = true; });
      b.classList.add("chosen");
      send({ t: "act", do: "commit", round, pick: i });
    };
    mine.appendChild(b);
  });
  $("theirs").textContent = options[1 - side].map((h, i) => `${i}: ${label(fromHex(h)!)}`).join("\n");
  $("opponent").dataset.committed = oppCommitted ? "1" : "";
  phase(committed ? "committed" : "choosing");
  status(committed ? "chosen — waiting for the reveal" : "choose one");
}

setInterval(() => {
  $("clock").textContent = deadline ? `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} s` : "";
}, 250);

function start(vs: "computer" | "person") {
  want = vs;
  reveals = [];
  $("menu").hidden = true;
  $("result").hidden = true;
  $("interrupted").hidden = true;
  status("connecting…");
  if (ws) ws.close();
  connect();
}
$("vs-computer").onclick = () => start("computer");
$("vs-person").onclick = () => start("person");

phase("menu");
// A match left in localStorage means this page was reloaded mid-match, or the
// server went away: reconnect and let `welcome` say which.
if (store.get(ROOM_KEY)) { $("menu").hidden = true; status("reconnecting…"); connect(); }
