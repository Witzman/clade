#!/usr/bin/env bash
# core-purity: core/ may only use arithmetic that is bit-identical in every
# JavaScript engine, may not touch the outside world, and may not import from
# outside itself. Workshop issues #23, #24.
#
# A grep: crude, and sufficient. It scans comments too, so write prose in
# core/ without the forbidden names. Usage: tests/core-purity.sh [dir]
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

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "core-purity: $dir/ is clean ($(find "$dir" -type f | wc -l | tr -d ' ') files)"
