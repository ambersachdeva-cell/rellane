#!/bin/bash
# Builds build/icon.icns from nothing but ImageMagick primitives.
#
# The mark is three ledger rules. The middle one is marigold and overshoots the
# block, carrying a peacock index at its end.
#
# It says what the product is: a record, and a point in it you can return to.
# DESIGN.md already assigns marigold "the line between what happened and what is
# coming", so the icon is spending the palette the way the interface does rather
# than inventing a logo language beside it.
#
# The first attempt was a broken dial with an index in the gap. It rendered as a
# power button. A mark that collides with the most universal glyph in computing
# is not a style disagreement, it is the wrong mark.
#
# Drawn rather than traced from SVG on purpose: ImageMagick has no librsvg
# delegate on this machine, and its own SVG renderer produces soft, wrong
# gradients. Primitives are exact, and a script that regenerates the icon beats
# a binary nobody can edit.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="apps/desktop/build"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

GROUND_TOP='#372C1F'   # warm ink-brown, lit from above
GROUND_BOT='#14100B'   # the product's ground
EDGE='#4E3F2E'         # --line-strong, opened up a step so the body has an edge
INK='#D9C9AF'          # --ink-2, the rules that are already written
MARIGOLD='#EDAE3E'     # the line between what happened and what is coming
PEACOCK='#2E9E93'      # action, the index

# 824 of 1024 is Apple's icon-grid body size; 185 corner radius matches the
# squircle the OS masks everything else to.
magick -size 824x824 gradient:"${GROUND_TOP}-${GROUND_BOT}" "$WORK/grad.png"
magick -size 824x824 xc:black -fill white -draw "roundrectangle 0,0 823,823 185,185" "$WORK/mask.png"
magick "$WORK/grad.png" "$WORK/mask.png" -alpha off -compose CopyOpacity -composite "$WORK/body.png"

magick -size 1024x1024 xc:none "$WORK/body.png" -geometry +100+100 -composite "$WORK/base.png"

# Three rules, 142px apart, 52 thick, round caps. The neutral pair is ragged —
# 319 and 258 long — because equal bars are a hamburger menu, and a hamburger
# menu is the second wrong mark this icon has worn.
#
# The middle rule is one continuous bar in two colours: marigold for the record
# as written, peacock for where it stands now. They meet at 665 with round caps
# on both sides, so the join stays seamless at every raster size.
#
# The group spans 252..772 — 520 wide, centred on 512, so the overshoot does not
# drag the mark off-axis, and large enough to hold the body at Dock size.
magick "$WORK/base.png" \
  -draw "fill none stroke '${EDGE}' stroke-width 3 roundrectangle 101,101 922,922 184,184" \
  -draw "fill none stroke '${INK}' stroke-width 52 stroke-linecap round line 252,370 571,370" \
  -draw "fill none stroke '${MARIGOLD}' stroke-width 52 stroke-linecap round line 252,512 665,512" \
  -draw "fill none stroke '${PEACOCK}' stroke-width 52 stroke-linecap round line 665,512 772,512" \
  -draw "fill none stroke '${INK}' stroke-width 52 stroke-linecap round line 252,654 510,654" \
  "$WORK/icon-1024.png"

rm -rf "$WORK/icon.iconset"
mkdir -p "$WORK/icon.iconset"
for spec in "16 16x16" "32 16x16@2x" "32 32x32" "64 32x32@2x" "128 128x128" \
            "256 128x128@2x" "256 256x256" "512 256x256@2x" "512 512x512" "1024 512x512@2x"; do
  set -- $spec
  magick "$WORK/icon-1024.png" -resize "${1}x${1}" -strip "$WORK/icon.iconset/icon_${2}.png"
done

iconutil -c icns "$WORK/icon.iconset" -o "$OUT/icon.icns"
cp "$WORK/icon-1024.png" "$OUT/icon.png"
echo "wrote $OUT/icon.icns ($(wc -c < "$OUT/icon.icns") bytes) and $OUT/icon.png"
