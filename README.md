# Clade

A browser game about breeding creatures from recombined real-world animal
features. A *clade* is a group of organisms sharing a common ancestor — which
is what a player's collection becomes after enough generations.

Work in progress. Not yet playable.

- Live: <https://game.witzman.de>
- Staging: <https://staging.game.witzman.de>

## Status

Foundation and deployment pipeline are built and verified. The game itself is
in concept and prototyping: three variants will be built and compared before
one direction is chosen.

The visual and mechanical register is **scientific** — naturalist, zoological,
taxonomic — rather than fantasy.

## Development

`core/` holds the rules every part of the game shares — the browser, the
server and each variant run the same code, and it must produce bit-identical
results in every JavaScript engine. It is pure: no IO, no DOM, no clock, no
engine randomness, and only arithmetic the language specification makes exact.
CI enforces that rather than trusting it:

| Check | Command |
|---|---|
| golden hashes under V8 and JavaScriptCore | `node tests/determinism.test.ts` · `bun tests/determinism.test.ts` |
| no engine-dependent maths, clocks or outside imports in `core/` | `bash tests/core-purity.sh` |
| types | `npm ci && npx tsc --noEmit` |

Node 22 runs the TypeScript directly; nothing needs building to run the tests.

## Reporting a problem

Open an issue. Include what happened, what you expected, and the shortest path
to see it again.
