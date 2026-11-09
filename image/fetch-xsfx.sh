#!/bin/sh
# Fetches the packer used by `--pack` (xsfx, a self-extracting packer): always the LATEST release of
# https://github.com/ratushnyi-labs/xsfx, into the build volume.
# Runs INSIDE the tools container with the network on (image.sh calls it: DC_NET=1 tools/dc sh image/fetch-xsfx.sh).
#
# - The latest release is found from the redirect of github.com/<repo>/releases/latest (no API quota involved).
# - The archive is checked against the SHA-256 that GitHub shows for that release asset (the "digest" of the releases API),
#   when the API answers; the SHA-256 that was used is always printed, so a build log says exactly which packer made the image.
# - Every archive that was downloaded stays in /w/cache/downloads/xsfx-<tag>-<arch>.tar.gz. When the release page cannot be
#   reached at all (retried for several minutes), the newest archive there is used and a warning is printed. Behind a network that
#   intercepts TLS, put an archive there by hand with that name.
# - The packer for the architecture of the machine (x86_64 or aarch64; the container runs on the architecture of its docker host).
# Result: /w/build/xsfx/latest/x/xsfx-<arch>-unknown-linux-musl (where image.sh looks for it) and /w/build/xsfx/latest/VERSION.
set -eu
repo=ratushnyi-labs/xsfx
case "$(uname -m)" in
    x86_64|amd64)  arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) echo "fetch-xsfx: no packer for $(uname -m)" >&2; exit 1 ;;
esac
name="xsfx-$arch-unknown-linux-musl"
dest=/w/build/xsfx/latest/x
cache=/w/cache/downloads
mkdir -p "$cache"

# the tag of the latest release: the page redirects to .../releases/tag/<tag>
tag=$(curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors --proto '=https' --tlsv1.2 -o /dev/null -w '%{url_effective}' \
    "https://github.com/$repo/releases/latest" 2>/dev/null | sed -n 's#.*/releases/tag/\(v[0-9][^/?]*\)$#\1#p') || tag=""

if [ -n "$tag" ]; then
    archive="$cache/xsfx-$tag-$arch.tar.gz"
    if [ ! -f "$archive" ]; then
        url="https://github.com/$repo/releases/download/$tag/$name.tar.gz"
        echo "fetch-xsfx: downloading $url"
        curl -fsSL --retry 8 --retry-delay 15 --retry-all-errors --proto '=https' --tlsv1.2 -o "$archive.part" "$url"
        mv "$archive.part" "$archive"
    fi
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
    # the digest GitHub shows for the asset (best effort: the API may be rate limited or down)
    auth=""; [ -z "${GITHUB_TOKEN:-}" ] || auth="Authorization: Bearer $GITHUB_TOKEN"
    expected=$(curl -fsSL --retry 3 --retry-delay 5 --retry-all-errors --proto '=https' --tlsv1.2 ${auth:+-H "$auth"} \
        "https://api.github.com/repos/$repo/releases/tags/$tag" 2>/dev/null |
        tr -d '\n' | sed 's/},[[:space:]]*{/}\n{/g' | grep "\"name\": *\"$name.tar.gz\"" |
        sed -n 's/.*"digest": *"sha256:\([0-9a-f]\{64\}\)".*/\1/p' | head -1) || expected=""
    if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
        echo "fetch-xsfx: FAIL - SHA-256 of $archive is $actual, the release shows $expected" >&2
        mv -f "$archive" "$archive.rejected"
        exit 1
    fi
    [ -n "$expected" ] && how="matches the digest of the release" || how="the release digest could not be read"
else
    # the release page cannot be reached: the newest archive kept from an earlier run
    archive=$(ls -t "$cache"/xsfx-v*-"$arch".tar.gz 2>/dev/null | head -1 || true)
    [ -n "$archive" ] || { echo "fetch-xsfx: FAIL - cannot find the latest release of $repo and there is no kept archive" >&2; exit 1; }
    tag=$(basename "$archive" | sed "s/^xsfx-\(v[^-]*\)-$arch.tar.gz$/\1/")
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
    how="WARNING: release page unreachable, kept archive used"
fi

rm -rf /w/build/xsfx/latest
mkdir -p "$dest"
tar -xzf "$archive" -C "$dest"
chmod +x "$dest/$name"
echo "$tag" > /w/build/xsfx/latest/VERSION
echo "fetch-xsfx: OK xsfx $tag $arch, sha256 $actual ($how)"
