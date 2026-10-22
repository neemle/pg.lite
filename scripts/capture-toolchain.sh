#!/bin/sh
# Records the exact tool versions of a builder into build/toolchain/<kind>.json.
# Runs inside the builder (./dcb <kind> make capture-toolchain); the versions are measured,
# never typed by hand. scripts/update-toolchain-lock.js merges the files into toolchain.lock.json.
set -eu
kind="${COMPACTDB_BUILDER:-}"
out="${1:-build/toolchain}"
mkdir -p "$out"

# First dotted number in a tool's version output.
ver() { "$@" 2>&1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1; }
tools=""
add() { # name version
    [ -n "$2" ] || { echo "capture-toolchain: no version for $1" >&2; exit 1; }
    tools="${tools}${tools:+,}\"$1\":\"$2\""
}

case "$kind" in
musl)
    add alpine "$(cat /etc/alpine-release)"
    add gcc "$(gcc -dumpfullversion)"
    add gcc-target "$(gcc -dumpmachine)"
    add musl "$(apk list --installed musl 2>/dev/null | awk 'NR==1{print $1}' | sed 's/^musl-//')"
    add binutils-ld "$(ver ld --version)"
    add make "$(ver make --version)"
    add bison "$(ver bison --version)"
    add flex "$(ver flex --version)"
    add perl "$(perl -e 'print substr($^V,1)')"
    add zlib "$(apk list --installed zlib-dev 2>/dev/null | awk 'NR==1{print $1}' | sed 's/^zlib-dev-//')"
    ;;
ref)
    add debian "$(cat /etc/debian_version)"
    add gcc "$(gcc -dumpfullversion)"
    add glibc "$(dpkg-query -W -f='${Version}' libc6)"
    add binutils-ld "$(ver ld --version)"
    add make "$(ver make --version)"
    add bison "$(ver bison --version)"
    add flex "$(ver flex --version)"
    add perl "$(perl -e 'print substr($^V,1)')"
    add icu "$(dpkg-query -W -f='${Version}' libicu-dev)"
    add readline "$(dpkg-query -W -f='${Version}' libreadline-dev)"
    add zlib "$(dpkg-query -W -f='${Version}' zlib1g-dev)"
    ;;
wasm)
    # clang, wasm-ld and the Binaryen tools sit in the SDK's own bin directory, not on PATH.
    PATH="${EMSDK:-/emsdk}/upstream/bin:$PATH"
    add emscripten "$(ver emcc --version)"
    add clang "$(ver clang --version)"
    # Binaryen versions are plain integers ("wasm-opt version 125 (version_125)").
    add binaryen "$(wasm-opt --version 2>&1 | sed -n 's/.*version \([0-9][0-9]*\).*/\1/p' | head -1)"
    add wasm-ld "$(ver wasm-ld --version)"
    add node "$(ver node --version)"
    add python "$(ver python3 --version)"
    add make "$(ver make --version)"
    ;;
*)
    echo "capture-toolchain: COMPACTDB_BUILDER is '$kind'; run through ./dcb musl|wasm" >&2
    exit 2
    ;;
esac

printf '{"kind":"%s","tools":{%s}}\n' "$kind" "$tools" > "$out/$kind.json"
echo "capture-toolchain: wrote $out/$kind.json"
cat "$out/$kind.json"
