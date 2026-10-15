#!/bin/sh
# Builds macos/Stash.app from Stash.swift and the PWA icon, and zips it into public/Stash.zip,
# which is what the website's "Get the Mac app" downloads — commit that zip with any Swift change.
# `--install` also copies the app to /Applications.
set -e
cd "$(dirname "$0")"
app=Stash.app
version=$(node -p "require('../package.json').version")

rm -rf "$app" Stash.iconset
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" Stash.iconset

# universal, so the download runs on Intel Macs as well
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target $arch-apple-macos14 Stash.swift -o Stash-$arch
done
lipo -create Stash-arm64 Stash-x86_64 -output "$app/Contents/MacOS/Stash"
rm Stash-arm64 Stash-x86_64

for s in 16 32 128 256 512; do
  sips -z $s $s ../public/icon-512.png --out Stash.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d ../public/icon-512.png --out Stash.iconset/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns Stash.iconset -o "$app/Contents/Resources/Stash.icns"
rm -rf Stash.iconset

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Stash</string>
  <key>CFBundleIdentifier</key><string>xyz.pyvno.stash</string>
  <key>CFBundleExecutable</key><string>Stash</string>
  <key>CFBundleIconFile</key><string>Stash</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict></plist>
EOF

codesign --force --sign - "$app"   # ad-hoc: enough to run on this Mac
echo "built macos/$app"
rm -f ../public/Stash.zip && ditto -c -k --keepParent "$app" ../public/Stash.zip && echo "zipped public/Stash.zip"

if [ "$1" = --install ]; then
  rm -rf "/Applications/$app" && cp -R "$app" /Applications/ && echo "installed /Applications/$app"
fi
