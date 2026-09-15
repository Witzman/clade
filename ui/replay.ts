// The fight replay: one action about every 300 ms, each named by its channel,
// with both sides' hit points and a skip button. Workshop issue #60 (build plan
// piece X2); variant directions §1.4.
//
// Presentation only. It plays a FightRecord from ui/fight-events.ts and decides
// nothing. Touch first: no hover, a 44 px skip target, one column that does not
// assume any width. Colours come from render/palette.ts and nowhere else.

import { ACCENT, INK, INK_SOFT, PAPER } from "../render/palette.ts";
import { describe, type FightEvent, type FightRecord, type Side } from "./fight-events.ts";

export type ReplayOptions = {
  /** Names shown over the bars and in the lines. */
  names?: Record<Side, string>;
  /** Milliseconds per action. */
  stepMs?: number;
  /** Called as each event is shown, including on skip (sound hooks go here). */
  onEvent?: (e: FightEvent, index: number, skipped: boolean) => void;
  /** Called once, when the end event is shown. */
  onEnd?: (record: FightRecord) => void;
};

export type Replay = {
  /** Jump to the result. */
  skip(): void;
  /** Stop timers and remove the element. */
  destroy(): void;
  /** Resolves when the end is shown, whether played through or skipped. */
  finished: Promise<void>;
};

const rgb = (c: readonly number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const STYLE_ID = "ui-replay-style";
const CSS = `
.rp { color: ${rgb(INK)}; font: 15px/1.4 system-ui, -apple-system, sans-serif; display: grid; gap: 10px; max-width: 640px; }
.rp-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rp-side { min-width: 0; }
.rp-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rp-side.rp-b .rp-name, .rp-side.rp-b .rp-hp { text-align: right; }
.rp-bar { position: relative; height: 14px; border: 1px solid ${rgb(INK)}; border-radius: 3px; background: ${rgb(PAPER)}; overflow: hidden; }
.rp-lost, .rp-fill { position: absolute; top: 0; bottom: 0; left: 0; }
.rp-side.rp-b .rp-lost, .rp-side.rp-b .rp-fill { left: auto; right: 0; }
.rp-lost { background: ${rgb(ACCENT)}; transition: width 450ms ease-out 150ms; }
.rp-fill { background: ${rgb(INK_SOFT)}; transition: width 120ms linear; }
.rp-hp { font-size: 13px; font-variant-numeric: tabular-nums; color: ${rgb(INK_SOFT)}; }
.rp-side.rp-hit .rp-bar { outline: 2px solid ${rgb(ACCENT)}; outline-offset: 1px; }
.rp-line { min-height: 2.8em; margin: 0; font-weight: 600; }
.rp-line .rp-who { color: ${rgb(INK_SOFT)}; font-weight: 400; }
.rp-log { list-style: none; margin: 0; padding: 0; font-size: 13px; color: ${rgb(INK_SOFT)}; display: grid; gap: 2px; }
.rp-log li { overflow-wrap: anywhere; }
.rp-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.rp-count { font-size: 13px; color: ${rgb(INK_SOFT)}; font-variant-numeric: tabular-nums; }
.rp-skip { font: inherit; min-height: 44px; min-width: 88px; padding: 8px 16px; border: 1px solid ${rgb(INK)};
  border-radius: 4px; background: #fff; color: ${rgb(INK)}; cursor: pointer; touch-action: manipulation; }
.rp-skip:disabled { opacity: .45; cursor: default; }
@media (prefers-reduced-motion: reduce) { .rp-lost, .rp-fill { transition: none; } }
`;

/** Lines kept visible under the current one. */
const LOG_LINES = 5;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function mountReplay(root: HTMLElement, record: FightRecord, opts: ReplayOptions = {}): Replay {
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const names = opts.names ?? { A: "A", B: "B" };
  const stepMs = opts.stepMs ?? 300;
  const { events } = record;
  const actions = events.filter(e => e.kind === "strike").length;

  const box = el("section", "rp");
  box.setAttribute("aria-label", "Fight replay");
  const sides = el("div", "rp-sides");
  const side = (s: Side) => {
    const wrap = el("div", `rp-side rp-${s.toLowerCase()}`);
    const bar = el("div", "rp-bar");
    const lost = el("div", "rp-lost"), fill = el("div", "rp-fill");
    bar.append(lost, fill);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", `${names[s]} hit points`);
    const hp = el("div", "rp-hp");
    wrap.append(el("div", "rp-name", names[s]), bar, hp);
    sides.append(wrap);
    const max = s === "A" ? record.A.hp : record.B.hp;
    return { wrap, lost, fill, hp, bar, max };
  };
  const view = { A: side("A"), B: side("B") };
  const line = el("p", "rp-line");
  line.setAttribute("aria-live", "polite");
  const log = el("ol", "rp-log");
  const foot = el("div", "rp-foot");
  const count = el("span", "rp-count");
  const skipBtn = el("button", "rp-skip", "Skip");
  skipBtn.type = "button";
  foot.append(count, skipBtn);
  box.append(sides, line, log, foot);
  root.appendChild(box);

  const setHp = (s: Side, hp: number) => {
    const v = view[s];
    const pct = `${(Math.max(0, Math.min(1, hp / v.max)) * 100).toFixed(1)}%`;
    v.fill.style.width = pct;
    v.lost.style.width = pct; // trails behind the fill through its delayed transition
    v.hp.textContent = `${Math.max(0, Math.ceil(hp))} / ${Math.ceil(v.max)}`;
    v.bar.setAttribute("aria-valuenow", String(Math.max(0, Math.ceil(hp))));
  };
  const reset = (s: Side) => {
    const v = view[s];
    v.fill.style.width = v.lost.style.width = "100%";
    v.bar.setAttribute("aria-valuemin", "0");
    v.bar.setAttribute("aria-valuemax", String(Math.ceil(v.max)));
    setHp(s, v.max);
  };
  reset("A"); reset("B");
  line.textContent = `${names.A} against ${names.B}`;

  let i = 0, shown = 0, timer: ReturnType<typeof setTimeout> | null = null, over = false;
  let resolve!: () => void;
  const finished = new Promise<void>(r => { resolve = r; });

  const text = (e: FightEvent) => {
    const words = describe(e, names);
    return e.kind === "strike" ? { who: `${names[e.side]}: `, what: words.join(" · ") } : { who: "", what: words.join(" · ") };
  };
  const pushLog = (s: string) => {
    const li = el("li", "", s);
    log.prepend(li);
    while (log.children.length > LOG_LINES) log.lastElementChild!.remove();
  };
  const showLine = (e: FightEvent) => {
    if (line.dataset.text) pushLog(line.dataset.text);
    const { who, what } = text(e);
    line.replaceChildren(el("span", "rp-who", who), document.createTextNode(what));
    line.dataset.text = who + what;
  };
  const hitFlash = (s: Side | null) => {
    view.A.wrap.classList.toggle("rp-hit", s === "A");
    view.B.wrap.classList.toggle("rp-hit", s === "B");
  };

  const show = (e: FightEvent, skipped: boolean) => {
    if (e.kind === "strike") {
      shown++;
      setHp("A", e.hpA); setHp("B", e.hpB);
      hitFlash(e.side === "A" ? "B" : "A");
    } else if (e.kind === "end") {
      setHp("A", e.hpA); setHp("B", e.hpB);
      hitFlash(null);
    }
    showLine(e);
    count.textContent = `action ${shown} of ${actions}`;
    opts.onEvent?.(e, events.indexOf(e), skipped);
    if (e.kind === "end") finish();
  };
  const finish = () => {
    if (over) return;
    over = true;
    skipBtn.disabled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    opts.onEnd?.(record);
    resolve();
  };
  const tick = () => {
    timer = null;
    if (over || i >= events.length) return;
    show(events[i++], false);
    if (!over) timer = setTimeout(tick, stepMs);
  };
  const skip = () => {
    if (over) return;
    if (timer) clearTimeout(timer);
    timer = null;
    // Show the result, with the last few actions in the log for context.
    const rest = events.slice(i);
    for (const e of rest.slice(0, -1)) {
      if (e.kind === "strike") shown++;
      opts.onEvent?.(e, events.indexOf(e), true);
    }
    const tail = rest.slice(Math.max(0, rest.length - 1 - LOG_LINES), -1);
    for (const e of tail) { const { who, what } = text(e); pushLog(who + what); }
    line.dataset.text = "";
    i = events.length;
    const end = rest[rest.length - 1];
    if (end) show(end, true);
  };
  skipBtn.addEventListener("click", skip);
  count.textContent = `action 0 of ${actions}`;
  timer = setTimeout(tick, stepMs);

  return {
    skip,
    destroy() { if (timer) clearTimeout(timer); timer = null; over = true; box.remove(); resolve(); },
    finished,
  };
}
