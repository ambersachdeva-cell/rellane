#!/usr/bin/env bash
#
# Put a batch of files to Gemini 3.7 Flash, in parallel, with the standing brief.
#
#   scripts/review.sh apps/desktop/src/main/book/*.ts
#   scripts/review.sh $(git diff --name-only main | grep '\.ts$')
#
# Findings land one file per input under .review/ and are printed at the end.
# **Nothing here edits anything.** Flash reviews; a person verifies and edits.
# It is confidently wrong often enough that applying findings unread would add
# guards for impossible states — see D-041.
#
# `high` is deliberate and not a knob: low and medium find more items, high is
# the only level that traces a defect through to its consequence, which is the
# difference between a finding and a style note.
set -uo pipefail

MODEL="gemini-3.7-flash-high"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRIEF="$ROOT/docs/REVIEW-BRIEF.md"
OUT="$ROOT/.review"

if [ $# -eq 0 ]; then
  echo "usage: scripts/review.sh <file.ts> [file.ts ...]" >&2
  exit 2
fi
if ! command -v agy >/dev/null 2>&1; then
  echo "agy is not on PATH. Antigravity provides the Gemini subscription." >&2
  exit 1
fi

mkdir -p "$OUT"
brief="$(cat "$BRIEF")"

for file in "$@"; do
  [ -f "$file" ] || continue
  (
    name="$(echo "$file" | tr '/' '_')"
    # Bounded output: four findings is what a person will actually act on, and
    # a longer list is where padding starts.
    agy -p "$brief

---

Review this file against the brief above. Real defects only. Reply exactly NONE if there are
none. At most 4 findings, each naming the concrete failure and its consequence.

FILE: $file

$(cat "$file")" --model "$MODEL" 2>/dev/null | tail -40 > "$OUT/$name.md"
    echo "  reviewed $file"
  ) &
done
wait

echo
# Only the files reviewed on THIS run. Printing everything in .review/ replayed
# stale reports from earlier batches as though they were new findings — which
# is worse than no output, because the reader acts on them a second time.
for file in "$@"; do
  [ -f "$file" ] || continue
  report="$OUT/$(echo "$file" | tr '/' '_').md"
  [ -f "$report" ] || continue
  # NONE is the expected answer for roughly a third of files. Printing those
  # would bury the findings that matter.
  if grep -qx "NONE" "$report" 2>/dev/null; then continue; fi
  echo "━━━ $file"
  cat "$report"
  echo
done
