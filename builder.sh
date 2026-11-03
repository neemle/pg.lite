#!/bin/sh
# builder.sh - patch, build and test pg.lite. The host needs only docker and git; everything else runs in containers.
#
#   ./builder.sh <command> <version> <target> [options]
#
#   command   patch   fetch the upstream source of that exact release (SHA-256 checked against tools/releases.txt) and
#                     apply the patches of that release (patches/, its family and span folders) to a copy of it
#             build   patch, then build: cli  -> the static one-file server and its Docker image
#                                        wasm -> the WebAssembly engine, the browser module, the demo, tools/dist/*.tar.gz
#             test    run the tests of what build made
#   version   latest, or a release: 18.6, 9.6.24 (a bare major such as 17 means the newest 17.x); ./builder.sh list shows them all
#   target    cli     PostgreSQL as one static executable, in a FROM scratch Docker image
#             wasm    PostgreSQL as WebAssembly for the browser (Worker + IndexedDB) and node
#
#   ./builder.sh build latest cli      ./builder.sh test 17.11 cli      ./builder.sh build 18.6 wasm --test
#   ./builder.sh list                  every release that can be built
#   ./builder.sh version 17            print the release a version argument stands for
#
# Options (after the target):
#   --test            build only: run the tests right after the build
#   --pack            cli: compress the executable with xsfx (about half the size, slower start)
#   --variant NAME    cli: compiler flavour of the static build, default min3 (smallest)
#   --tag NAME        cli: also tag the finished image as NAME (for example myorg/postgres:18.6)
#
# test builds first when there is nothing to test yet, so on a laptop one command is enough: ./builder.sh test 17.11 cli
# cli tests use the unmodified upstream build of the same release as the external client (psql). It is built once (a while) and kept
# as the image compactdb-reference:<version>; with CLIENT_IMAGE=<image with psql> (for example postgres:18-alpine) it is skipped.
# Behind a TLS-inspecting proxy that breaks the download: FETCH_HTTP_FALLBACK=1 ./builder.sh ... (the pinned SHA-256 is still checked).
# CI runs exactly these commands: .github/workflows/release.yml fetches and patches, builds, tests, then uploads.
set -eu
root=$(cd "$(dirname "$0")" && pwd)
cd "$root"

usage() { sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
die() { echo "builder.sh: $*" >&2; exit 1; }
step() { echo; echo "=== $*"; }

command -v docker >/dev/null 2>&1 || die "docker is required (it is the only tool the host needs)"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

command="${1:-}"
case "$command" in
    ""|-h|--help|help) usage 0 ;;
esac
shift

# ---- version arguments: latest, a bare major, or a release
releases=tools/releases.txt
known_versions() { awk '!/^#/ && NF { print $1 }' "$releases"; }
newest_of() { # $1 = major, or empty for any
    awk -v m="$1" '!/^#/ && NF && (m == "" || $2 "" == m "") { print $1 }' "$releases" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 | grep .
}
resolve_version() {
    case "$1" in
        latest) newest_of "" || die "no release in $releases" ;;
        *.*.*|[1-9][0-9].*) known_versions | grep -qx "$1" || die "PostgreSQL $1 is not a release known to $releases (./builder.sh list)"; echo "$1" ;;
        *) newest_of "$1" || die "no release of major '$1' (./builder.sh list)" ;;
    esac
}

case "$command" in
    list)
        awk '!/^#/ && NF { v[$2] = v[$2] " " $1; n[$2]++ } END { for (m in v) printf "%-5s %d releases:%s\n", m, n[m], v[m] }' "$releases" | sort -rn
        exit 0 ;;
    version)
        [ $# -ge 1 ] || usage
        resolve_version "$1"
        exit 0 ;;
    patch|build|test) ;;
    *) echo "builder.sh: unknown command '$command'" >&2; usage ;;
esac

[ $# -ge 2 ] || { echo "builder.sh: $command needs a version and a target" >&2; usage; }
version=$(resolve_version "$1")
target="$2"
shift 2
case "$target" in cli|wasm) ;; *) die "unknown target '$target' (cli or wasm)" ;; esac

test_it=0; pack=""; variant="min3"; extra_tag=""
while [ $# -gt 0 ]; do
    case "$1" in
        --test) test_it=1 ;;
        --pack) pack=xsfx ;;
        --variant) shift; variant="${1:?--variant needs a name}" ;;
        --tag) shift; extra_tag="${1:?--tag needs a name}" ;;
        -h|--help) usage 0 ;;
        *) die "unknown option '$1'" ;;
    esac
    shift
done
[ "$target" = cli ] || { [ -z "$pack" ] && [ -z "$extra_tag" ] && [ "$variant" = min3 ]; } || die "--pack, --variant and --tag apply to the cli target"
[ "$command" = build ] || [ "$test_it" = 0 ] || die "--test belongs to the build command"
echo "builder.sh: $command PostgreSQL $version ($target)"

# ---- patch: the verified upstream source plus the patches of the release
do_patch() {
    src=native; [ "$target" = wasm ] && src=wasm
    step "fetch PostgreSQL $version (verified against the pinned SHA-256)"
    tools/dc make fetch VERSION="$version"
    step "apply the patches for $target"
    tools/dc make "$src-src" VERSION="$version"
}

# ---- cli
image_tag() { echo "compactdb-native:$version-$variant${pack:+-$pack}"; }
build_cli() {
    export VARIANT="$variant"
    step "build the static server with initdb, the entrypoint and the data files linked in (variant $variant)"
    tools/dcb musl make native-build VERSION="$version"
    step "assemble the image: one file"
    PACK="$pack" image/image.sh image "$version"
    image/image.sh manifest "$version"
    tag=$(image_tag)
    [ -z "$extra_tag" ] || { docker tag "$tag" "$extra_tag"; echo "builder.sh: also tagged $extra_tag"; }
    echo
    echo "builder.sh: image $tag ($(docker image inspect "$tag" --format '{{.Size}}') bytes)"
    echo "  docker run -d -e POSTGRES_PASSWORD=change-me -v pgdata:/var/lib/postgresql/data -p 5432:5432 ${extra_tag:-$tag}"
}
test_cli() {
    export VARIANT="$variant"
    if ! docker image inspect "$(image_tag)" >/dev/null 2>&1; then
        echo "builder.sh: no image $(image_tag) yet, building it first"
        do_patch
        build_cli
        export VARIANT="$variant"
    fi
    step "unit tests of the shell-free spawn code"
    tools/dcb musl make test-noshell VERSION="$version"
    if [ -z "${CLIENT_IMAGE:-}" ] && ! docker image inspect "compactdb-reference:$version" >/dev/null 2>&1; then
        step "the unmodified upstream build of the same release, whose psql is the external test client"
        tools/dcb ref make builder-check
        tools/dcb ref make reference VERSION="$version"
        image/reference.sh image "$version"
    fi
    step "image tests: cold init, SQL, modules, authentication, restart, non-empty data directory"
    PACK="$pack" image/image.sh test "$version"
}

# ---- wasm
build_wasm() {
    unset VARIANT
    step "build the node-hosted WebAssembly server and the template data directory"
    tools/dcb wasm make wasm-build VERSION="$version"
    step "build the browser module"
    WEB=1 tools/dcb wasm make wasm-build VERSION="$version"
    step "compile the TypeScript browser module (TypeScript 7)"
    DC_NET=1 tools/dcb web sh wasm/web-install.sh wasm
    tools/dcb web sh wasm/web-lib.sh build
    step "build the Angular + TypeORM demo"
    DC_NET=1 tools/dcb web sh wasm/web-install.sh wasm/demo
    tools/dcb web make web-demo VERSION="$version"
    step "package the archive"
    tools/dc make package-wasm VERSION="$version"
    echo
    echo "builder.sh: tools/dist/pg.lite-wasm-$version.tar.gz (+ .sha256, .sizes.txt)"
}
test_wasm() {
    unset VARIANT
    if [ ! -f "tools/dist/pg.lite-wasm-$version.tar.gz" ]; then
        echo "builder.sh: no browser module for $version yet, building it first"
        do_patch
        build_wasm
        unset VARIANT
    fi
    step "SQL smoke test under node"
    tools/dcb wasm make test-wasm-node VERSION="$version"
    step "browser module: types, lint (oxlint) and unit tests (vitest)"
    DC_NET=1 tools/dcb web sh wasm/web-install.sh wasm
    tools/dcb web sh wasm/web-lib.sh typecheck
    tools/dcb web sh wasm/web-lib.sh lint
    tools/dcb web sh wasm/web-lib.sh test
    step "browser tests (Chromium, real Worker, real IndexedDB) and the demo"
    DC_NET=1 tools/dcb web sh wasm/web-install.sh wasm/tests/browser
    tools/dcb web make test-wasm VERSION="$version"
}

case "$command" in
    patch) do_patch ;;
    build)
        do_patch
        "build_$target"
        [ "$test_it" = 0 ] || "test_$target"
        ;;
    test) "test_$target" ;;
esac
