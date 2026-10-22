#!/bin/sh
# Runs inside the tools container (needs sh, curl, sha256sum, tar+bzip2, git).
# Env: VERSION TAG COMMIT GIT_URL ARCHIVE_URL SHA256 CACHE(default /cache) OFFLINE(0|1)
# Result: verified source tree in $CACHE/src/$VERSION. Exit 0 ok, 1 verification failure,
# 2 cannot proceed (offline and archive not cached).
set -eu
: "${VERSION:?}" "${TAG:?}" "${COMMIT:?}" "${GIT_URL:?}" "${ARCHIVE_URL:?}" "${SHA256:?}"
CACHE="${CACHE:-/cache}"
OFFLINE="${OFFLINE:-0}"
dl="$CACHE/downloads"
src="$CACHE/src/$VERSION"
archive="$dl/postgresql-$VERSION.tar.bz2"
marker="$src/.compactdb-verified"
mkdir -p "$dl" "$CACHE/src"

if [ -f "$marker" ] && grep -qx "sha256=$SHA256" "$marker" && grep -qx "commit=$COMMIT" "$marker"; then
    echo "fetch: cache hit for $VERSION ($src), nothing downloaded"
    exit 0
fi

if [ ! -f "$archive" ]; then
    if [ "$OFFLINE" = "1" ]; then
        echo "fetch: $archive is not cached and offline mode is on" >&2
        exit 2
    fi
    echo "fetch: downloading $ARCHIVE_URL"
    rm -f "$archive.part"
    curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$archive.part" "$ARCHIVE_URL"
    mv "$archive.part" "$archive"
fi

actual=$(sha256sum "$archive" | cut -d' ' -f1)
if [ "$actual" != "$SHA256" ]; then
    echo "fetch: FAIL - SHA-256 mismatch for $VERSION" >&2
    echo "  expected: $SHA256" >&2
    echo "  actual:   $actual" >&2
    mv -f "$archive" "$archive.rejected"
    echo "  archive kept as $archive.rejected and not extracted" >&2
    exit 1
fi
echo "fetch: archive SHA-256 verified ($actual)"

if [ "$OFFLINE" != "1" ]; then
    remote=$(git ls-remote --tags "$GIT_URL" "refs/tags/$TAG" | cut -f1)
    if [ "$remote" != "$COMMIT" ]; then
        echo "fetch: FAIL - tag $TAG resolves to '${remote:-<not found>}' at $GIT_URL, lock expects $COMMIT" >&2
        exit 1
    fi
    echo "fetch: tag $TAG resolves to the locked commit ($COMMIT)"
else
    echo "fetch: offline, tag-to-commit check skipped"
fi

rm -rf "$src.tmp"
mkdir -p "$src.tmp"
tar -xjf "$archive" -C "$src.tmp" --strip-components=1
for f in configure COPYRIGHT; do
    if [ ! -f "$src.tmp/$f" ]; then
        echo "fetch: FAIL - extracted tree has no $f" >&2
        rm -rf "$src.tmp"
        exit 1
    fi
done
rm -rf "$src"
mv "$src.tmp" "$src"
printf 'sha256=%s\ncommit=%s\nversion=%s\n' "$SHA256" "$COMMIT" "$VERSION" > "$marker"
echo "fetch: OK $VERSION -> $src"
