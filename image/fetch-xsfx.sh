#!/bin/sh
# Fetches the packer used by `--pack` (xsfx, a self-extracting packer) into the build volume, checked against a pinned SHA-256.
# Runs INSIDE the tools container with the network on (image.sh calls it: DC_NET=1 tools/dc sh image/fetch-xsfx.sh).
# Behind a network that intercepts TLS, put the archive into the cache by hand (/w/cache/downloads/xsfx-<version>.tar.gz):
# it is used when it is there, and the SHA-256 below is checked either way.
# Result: /w/build/xsfx/<version>/x/xsfx-x86_64-unknown-linux-musl, where image.sh looks for it. Nothing is downloaded when it is there.
set -eu
version=v0.2.0
sha256=cfb0545571e2bcdded6df804333539e7af7fc2c41cf071195e95f55769d09592
url="https://github.com/ratushnyi-labs/xsfx/releases/download/$version/xsfx-x86_64-unknown-linux-musl.tar.gz"
dest="/w/build/xsfx/$version/x"
bin="$dest/xsfx-x86_64-unknown-linux-musl"
[ ! -x "$bin" ] || { echo "fetch-xsfx: $bin is there"; exit 0; }

archive="/w/cache/downloads/xsfx-$version.tar.gz"
mkdir -p /w/cache/downloads "$dest"
if [ ! -f "$archive" ]; then
    echo "fetch-xsfx: downloading $url"
    curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$archive.part" "$url"
    mv "$archive.part" "$archive"
fi
actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ "$actual" != "$sha256" ]; then
    echo "fetch-xsfx: FAIL - SHA-256 mismatch (expected $sha256, got $actual)" >&2
    mv -f "$archive" "$archive.rejected"
    exit 1
fi
tar -xzf "$archive" -C "$dest"
chmod +x "$bin"
echo "fetch-xsfx: OK $bin"
