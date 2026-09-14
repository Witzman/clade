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
let retry = 0, openedAt = 0, lastError = "";

const phase = (p: string) => { document.body.dataset.phase = p; };
const status = (s: string) => { $("status").textContent = s; };
const log = (s: string) => { $("log").textContent = s + "\n" + $("log").textContent; };
const notice = (s: string | null) => { $("notice").hidden = !s; $("notice").textContent = s ?? ""; };
const send = (m: object) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => { openedAt = Date.now(); send({ t: "hello", v: 1, id, name: `player ${id.slice(0, 4)}`, variant: "test" }); };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = e => {
    ws = null;
    // 4xxx is an application close: the server shut this socket deliberately
    // and said why in the `error` frame just before it. Reconnecting would
    // undo the server's decision — and when the reason is "replaced", two tabs
    // of the same player reconnect over each other for as long as both are
    // open (#36). This is the one close that is not a lost connection.
    if (e.code >= 4000 && e.code <= 4999) return closedByServer();
    // Only a connection that lasted counts as a good one. Resetting the
    // backoff in `onopen` made every retry the first retry, so a socket closed
    // the moment it opened looped at 500 ms forever.
    if (openedAt && Date.now() - openedAt > 5000) retry = 0;
    if (store.get(ROOM_KEY)) {
      // In a match: reconnect. Whether the match survived is the server's
      // answer in `welcome`, not a guess made here.
      phase("reconnecting");
      status(`connection lost (${e.code}) — reconnecting…`);
      setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
    } else if (document.body.dataset.phase !== "result" && document.body.dataset.phase !== "interrupted") {
      phase("menu");
      status(e.code === 1013 ? "server full — try again later" : "idle");
      $("menu").hidden = false;
    }
  };
}

// The server closed this socket on purpose. Say so and stop: the room key is
// deliberately left in localStorage, because the tab that replaced this one
// shares it and is using the match.
function closedByServer() {
  phase(lastError === "replaced" ? "replaced" : "closed");
  $("match").hidden = true;
  notice(lastError === "replaced"
    ? "This match is open in another tab. That tab has it now — reload this page to take it back."
    : `The server closed this connection${lastError ? `: ${lastError}` : ""}.`);
  status(lastError === "replaced" ? "open in another tab" : "disconnected");
  deadline = null;
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
      const why = m.reason === "opponentLeft" ? " (the opponent left)" : "";
      $("result").hidden = false;
      $("result").textContent = `result: ${outcome}${why} ${m.wins[side]}–${m.wins[1 - side]} · hash ${m.hash} ${verdict}`;
      notice(null);
      store.del(ROOM_KEY);
      phase("result");
      status("match over");
      deadline = null;
      ws?.close(1000, "match over");
      return;
    }
    case "error": {
      lastError = String(m.reason ?? "");
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
    // The seat opposite emptied, filled again, or emptied for good (#38). The
    // clock comes with the message because the room stops it while the seat is
    // empty, so nobody loses a round to somebody else's dropped connection.
    case "opponentGone":
      deadline = m.deadline ?? null;
      $("opponent").dataset.gone = "1";
      notice(`The opponent's connection dropped. The clock is stopped; they have ` +
             `${Math.round((m.grace ?? 0) / 1000)} s to come back.`);
      return log("the opponent's connection dropped");
    case "opponentBack":
      deadline = m.deadline ?? null;
      $("opponent").dataset.gone = "";
      notice(null);
      return log("the opponent is back");
    case "opponentLeft":
      deadline = m.deadline ?? null;
      $("opponent").dataset.gone = "1";
      notice("The opponent has left the match.");
      return log("the opponent left the match");
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
  notice(null);
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
