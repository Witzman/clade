#!/usr/bin/env bash
# core-purity: core/ may only use arithmetic that is bit-identical in every
# JavaScript engine, may not touch the outside world, and may not import from
# outside itself. Workshop issues #23, #24.
#
# A grep: crude, and sufficient. It scans comments and strings too, so write
# prose in core/ without the forbidden names and without the two characters
# `**` (see the exponentiation check below). Usage: tests/core-purity.sh [dir]
#
# The gate has its own test: tests/core-purity.test.sh, which mutates a
# throwaway directory one line at a time and asserts the verdict. Change a
# pattern here and add the mutation there, or the next hole lives as long as
# the last one did (workshop #35, then #43).
set -euo pipefail

dir="${1:-core}"
[ -d "$dir" ] || { echo "::error::no such directory: $dir"; exit 1; }
fail=0

check() { # check <message> <grep -E pattern>
  local hits
  hits=$(grep -rnE "$2" "$dir" || true)
  if [ -n "$hits" ]; then
    echo "::error::$1"
    echo "$hits"
    fail=1
  fi
}

# Implementation-approximated functions: V8 and JavaScriptCore disagree in
# the last bit on 3-37 % of inputs, which is enough to change a fight.
check "engine-dependent Math function in $dir/" \
  'Math\.(pow|exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|hypot|cbrt|random)\b'

# The exponentiation operator is the same implementation-approximated
# operation as Math.pow (ECMA-262 Number::exponentiate), and V8 and JSC hash
# 1e6 results differently.
#
# NO EXEMPTION, deliberately (workshop #43). The operator's token is exactly
# the two characters `**` and nothing can be written between them, so every
# occurrence of that sequence is either the operator or prose -- but the
# converse is not decidable by grep: `**` next to a `/` is a JSDoc delimiter
# in one file, and in the next it is a block comment shoved between the
# operands -- node evaluates `a ** /*c*/ b` with those spaces removed as
# plain `a ** b`. The old exemption for `/**` and `**/` let five such
# spellings through (workshop #43 has them, with node's output).
# So core/ forbids the two characters outright and uses `//` comments; a
# pattern with no exemption has nothing to hide behind.
check "the characters \`**\` in $dir/ -- exponentiation is implementation-approximated, like Math.pow; core/ uses // comments, not /** */" \
  '\*\*'

# The same functions reached indirectly: Math["pow"], const { pow } = Math,
# f(Math). Anything that names Math other than as Math.<name>.
check "indirect access to Math in $dir/" \
  '\bMath([^.A-Za-z0-9_$]|$)'

# Clocks. Wall time is not a pure input.
check "clock access in $dir/" '\bDate\b|\bperformance\b'

# Imports: only sibling files inside core/, by explicit ./name.ts path.
specs=$(grep -rnoE "(from|import)[[:space:]]*[\"'][^\"']*[\"']" "$dir" || true)
bad=$(printf '%s\n' "$specs" | grep -vE "[\"']\./[A-Za-z0-9_-]+\.ts[\"']$" | grep -v '^$' || true)
if [ -n "$bad" ]; then
  echo "::error::import from outside $dir/"
  echo "$bad"
  fail=1
fi
check "dynamic import or require in $dir/" '\bimport[[:space:]]*\(|\brequire[[:space:]]*\('

# A symlink inside $dir is read by nothing here -- `grep -r` does not follow
# one -- but node does, so a link to a file outside core/ would run with none
# of the rules above applied. Found while closing #43; there is no legitimate
# use for one in core/.
links=$(find "$dir" -type l || true)
if [ -n "$links" ]; then
  echo "::error::symlink in $dir/ -- every file $dir/ runs must live in $dir/"
  echo "$links"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "core-purity: $dir/ is clean ($(find "$dir" -type f | wc -l | tr -d ' ') files)"
