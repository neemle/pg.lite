#!/bin/sh
# Fetches the packer used by `--pack` (xsfx, a self-extracting packer) into the build volume, checked against a pinned SHA-256.
# Runs INSIDE the tools container with the network on (image.sh calls it: DC_NET=1 tools/dc sh image/fetch-xsfx.sh).
# Behind a network that intercepts TLS, put the archive into the cache by hand (/w/cache/downloads/xsfx-<version>-<arch>.tar.gz):
# it is used when it is there, and the SHA-256 below is checked either way.
# The packer for the architecture of the machine (x86_64 or aarch64; the container runs on the architecture of its docker host).
# Result: /w/build/xsfx/<version>/x/xsfx-<arch>-unknown-linux-musl, where image.sh looks for it. Nothing is downloaded when it is there.
set -eu
version=v0.2.0
case "$(uname -m)" in
    x86_64|amd64)  arch=x86_64;  sha256=cfb0545571e2bcdded6df804333539e7af7fc2c41cf071195e95f55769d09592 ;;
    aarch64|arm64) arch=aarch64; sha256=adbd972464bed75e1c8fc13c4c42531faebe6b3f789d21a703bda94cc300a0d2 ;;
    *) echo "fetch-xsfx: no packer for $(uname -m)" >&2; exit 1 ;;
esac
url="https://github.com/ratushnyi-labs/xsfx/releases/download/$version/xsfx-$arch-unknown-linux-musl.tar.gz"
dest="/w/build/xsfx/$version/x"
bin="$dest/xsfx-$arch-unknown-linux-musl"
[ ! -x "$bin" ] || { echo "fetch-xsfx: $bin is there"; exit 0; }

archive="/w/cache/downloads/xsfx-$version-$arch.tar.gz"
# the archive that older versions of this script cached under the name without the architecture was the x86_64 one
[ "$arch" != x86_64 ] || [ -f "$archive" ] || [ ! -f "/w/cache/downloads/xsfx-$version.tar.gz" ] || cp "/w/cache/downloads/xsfx-$version.tar.gz" "$archive"
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
