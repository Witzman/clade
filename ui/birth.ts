// Birth sentences: plain English generated from core's Fusion records, never
// written by hand. Workshop issue #61 (feature model §6 item 2, §13).
//
// DOM-free, so tests/ui-birth.test.ts drives it under Node.
//
// What the record holds, and so what a sentence may claim:
//   system, formA, formB  the body system and the two parents' forms that met
//   disputed              the dimension the two copies differed on most
//   moved                 the dimension the fusion shifted most
//   by                    the MEAN difference over the five dimensions. It is
//                         not the disputed dimension's own gap, so the text
//                         says "differed by N, most about X", never "by N
//                         about X".
// It does not hold the new part's name, which mutation can still change after
// the fusion, so no sentence names it.

import { FORMS, NA, NL, NM, SYSTEMS, label } from "../core/index.ts";
import type { Fusion, Genome } from "../core/index.ts";
import { DIMENSIONS } from "./words.ts";

const inRange = (x: number, n: number) => Number.isInteger(x) && x >= 0 && x < n;

/** One fusion as one line: "head: biting jaws met long snout. They differed by 42, most about reach; the fusion put that into sharpness." */
export function fusionSentence(f: Fusion): string {
  if (!inRange(f.system, NL) || !inRange(f.formA, NM) || !inRange(f.formB, NM)
    || !inRange(f.disputed, NA) || !inRange(f.moved, NA) || !Number.isFinite(f.by)) {
    throw new RangeError(`not a fusion record: ${JSON.stringify(f)}`);
  }
  const forms = FORMS[f.system];
  const met = `${SYSTEMS[f.system]}: ${forms[f.formA]} met ${forms[f.formB]}.`;
  const by = Math.round(Math.abs(f.by));
  const moved = DIMENSIONS[f.moved];
  if (by === 0) {
    return `${met} Their numbers matched but the forms did not; the fusion shifted ${moved} most.`;
  }
  const disputed = DIMENSIONS[f.disputed];
  const where = f.moved === f.disputed ? `put that back into ${moved}` : `put that into ${moved}`;
  return `${met} They differed by ${by}, most about ${disputed}; the fusion ${where}.`;
}

/** Every line of a birth card. A birth with no fusion still gets one line, so a card is never blank. */
export function birthSentences(fusions: readonly Fusion[]): string[] {
  if (fusions.length === 0) return ["No parts fused."];
  return fusions.map(fusionSentence);
}

/** The line naming a young creature's parents, by their derived names. */
export function parentsLine(a: Genome, b: Genome): string {
  return `Young of ${label(a)} and ${label(b)}.`;
}
