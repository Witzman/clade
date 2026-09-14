#!/usr/bin/env bash
# The test for the gate. tests/core-purity.sh is the only thing standing
# between core/ and arithmetic that V8 and JavaScriptCore disagree about, and
# it has been wrong twice: it missed the exponentiation operator entirely
# (workshop #35), and after that fix it still missed five spellings where a
# block comment sits next to the operator (workshop #43). Both holes survived
# because nothing exercised the check itself.
#
# So: build a throwaway directory, add one line, run the real check, assert the
# verdict. Every line marked `reject` below is a construct node evaluates as
# the forbidden operation -- `a **/*c*/ b` is `a ** b`, checked with node.
#
# Usage: bash tests/core-purity.test.sh          (npm run test:purity-gate)
set -uo pipefail

check="$(cd "$(dirname "$0")" && pwd)/core-purity.sh"
[ -f "$check" ] || { echo "no core-purity.sh next to this test"; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
pass=0; failed=0

# run <reject|accept> <name> <payload appended to the throwaway file>
run() {
  local want="$1" name="$2" payload="${3-}"
  rm -rf "$tmp/core"; mkdir -p "$tmp/core"
  printf 'export const two = 2;\n' > "$tmp/core/probe.ts"
  [ -n "$payload" ] && printf '%b\n' "$payload" >> "$tmp/core/probe.ts"
  bash "$check" "$tmp/core" >/dev/null 2>&1; local code=$?
  local ok
  if [ "$want" = reject ]; then [ "$code" -ne 0 ] && ok=1 || ok=0
  else [ "$code" -eq 0 ] && ok=1 || ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass+1)); printf '  ok   %-8s %s\n' "$want" "$name"
  else failed=$((failed+1)); printf '  FAIL %-8s %s (exit %d)\n' "$want" "$name" "$code"; fi
}

echo "core-purity gate, exponentiation operator:"
run reject 'a ** b'                     'const q = a ** b;'
run reject 'x**2, no spaces'            'const q = x**2;'
run reject '**= compound assignment'    'let q = 2; q **= 3;'
run reject '(a)**(b)'                   'const q = (a)**(b);'
run reject 'operator at end of line'    'const q = a **\n  b;'
run reject 'operator at start of line'  'const q = a\n  ** b;'
# The five that got past the #35 fix. #43 has node's output for each.
run reject 'comment between operands'   'const q = a **/*c*/ b;'
run reject 'comment before operator'    'const q = a/**/** b;'
run reject 'comments on both sides'     'const q = a/**/**/**/b;'
run reject 'operator then comment'      'const q = a **/**/b;'
run reject '**= behind a comment'       'let q = 2; q /*c*/**= 3;'
# No exemption means these are rejected too, and that is the point: core/ uses
# // comments. Re-exempting any of them re-opens the hole above.
run reject 'JSDoc block opener'         '/**\n * doc\n */'
run reject 'JSDoc one-liner'            '/** doc */'
run reject '** in a line comment'       '// prose about a ** b'
run reject '** in a string'             'const q = "a ** b";'

echo "core-purity gate, the rest:"
run reject 'Math.pow'                   'const q = Math.pow(a, b);'
run reject 'Math reached indirectly'    'const q = Math["pow"](a, b);'
run reject 'clock'                      'const q = Date.now();'
run reject 'require'                    'const q = require("node:fs");'
run reject 'dynamic import'             'const q = import("./other.ts");'
run reject 'import from outside'        'import { q } from "../server/main.ts";'

echo "core-purity gate, what must still pass:"
run accept 'a clean file'
run accept 'plain multiplication'       'const q = a * b;'
run accept 'a line comment'             '// an ordinary note'
run accept 'a block comment'            '/* an ordinary note */'
run accept 'a sibling import'           'import { two } from "./probe.ts";'

# A symlink is followed by node and by nothing above: grep -r skips it.
rm -rf "$tmp/core"; mkdir -p "$tmp/core"
printf 'export const two = 2;\n' > "$tmp/core/probe.ts"
printf 'export const q = (a, b) => a ** b;\n' > "$tmp/outside.ts"
ln -s ../outside.ts "$tmp/core/link.ts"
bash "$check" "$tmp/core" >/dev/null 2>&1; code=$?
if [ "$code" -ne 0 ]; then pass=$((pass+1)); printf '  ok   %-8s %s\n' reject 'symlink out of core/'
else failed=$((failed+1)); printf '  FAIL %-8s %s (exit %d)\n' reject 'symlink out of core/' "$code"; fi

echo
if [ "$failed" -ne 0 ]; then
  echo "core-purity gate: $failed of $((pass+failed)) assertions FAILED"
  exit 1
fi
echo "core-purity gate: $pass assertions, all pass"
