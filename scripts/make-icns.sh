#!/bin/bash
# Turns build/icon.png into build/icon.icns with every size macOS asks for.
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE=build/icon.png
ICONSET=build/icon.iconset

[ -f "$SOURCE" ] || { echo "missing $SOURCE — run: npx electron scripts/make-icon.cjs" >&2; exit 1; }

rm -rf "$ICONSET"
mkdir -p "$ICONSET"

while read -r size name; do
  sips -Z "$size" "$SOURCE" --out "$ICONSET/$name.png" >/dev/null
done <<SIZES
16 icon_16x16
32 icon_16x16@2x
32 icon_32x32
64 icon_32x32@2x
128 icon_128x128
256 icon_128x128@2x
256 icon_256x256
512 icon_256x256@2x
512 icon_512x512
1024 icon_512x512@2x
SIZES

iconutil --convert icns "$ICONSET" --output build/icon.icns
rm -rf "$ICONSET"
echo "wrote build/icon.icns"
