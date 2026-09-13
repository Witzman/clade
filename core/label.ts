// Plain-English name from the two loudest expressed parts. Derived, never stored.
// Workshop issues #21, #23.

import { express } from "./express.ts";
import { NA, NO_GRAFT, SYSTEMS, FORMS, form, graft, vecAt } from "./genome.ts";
import type { Genome } from "./genome.ts";

const ADJ = [["solid", "heavy", "massive"], ["short", "long", "far-reaching"],
  ["sharp", "keen", "needle-sharp"], ["quick", "fast", "blink-fast"], ["tough", "hard", "armoured"]];

export function label(g: Genome): string {
  const { expr } = express(g);
  const mags = SYSTEMS.map((_, l) => [0, 1, 2, 3, 4].reduce((s, a) => s + Math.abs(vecAt(g, l, expr[l], a)), 0));
  const top = mags.map((m, l) => [m, l]).sort((x, y) => y[0] - x[0] || x[1] - y[1]).slice(0, 2);
  return top.map(([, l]) => {
    const s = expr[l];
    let da = 0;
    for (let a = 1; a < NA; a++) if (Math.abs(vecAt(g, l, s, a)) > Math.abs(vecAt(g, l, s, da))) da = a;
    const mag = Math.abs(vecAt(g, l, s, da));
    let noun = FORMS[l][form(g, l, s)];
    const gr = graft(g, l, s);
    if (gr !== NO_GRAFT && gr !== form(g, l, s)) noun += "/" + FORMS[l][gr];
    return `${ADJ[da][mag < 34 ? 0 : mag < 67 ? 1 : 2]} ${noun}`;
  }).join(", ");
}
