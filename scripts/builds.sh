#!/bin/sh
# The matrices of the image jobs of ci.yml, as JSON, for a list of releases.
#   sh scripts/builds.sh '["9.2.5","9.2.6"]'      prints  builds=...  refs=...  and  tests=...  (lines for $GITHUB_OUTPUT)
# builds: one entry per release, architecture and flavour   {"version":"9.2.5","arch":"amd64","runner":"ubuntu-24.04","variant":"min3","tagsuffix":""}
#         The flavour "min3" is the image of every release. From PostgreSQL 17 on there is a second one, "min3full" (tag suffix "-full"):
#         the same server with zlib, and pg_dump and pg_restore linked into the executable.
# refs:   one entry per release and architecture (the reference image that the image tests use as the external client; one per release)
# tests:  the builds entries, once per image kind (plain, compressed) for the test-image job
# A release gets an arm64 entry when scripts/has-arm64.sh says so; arm64 is built and tested natively on an arm64 runner.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
list=$(printf '%s' "${1:?usage: builds.sh '[\"9.2.5\"]'}" | tr -d '[]" ' | tr ',' ' ')
builds=""; refs=""
for v in $list; do
    archs="amd64:ubuntu-24.04"
    if sh "$here/has-arm64.sh" "$v"; then archs="$archs arm64:ubuntu-24.04-arm"; fi
    for ar in $archs; do
        arch=${ar%%:*}; runner=${ar#*:}
        refs="$refs{\"version\":\"$v\",\"arch\":\"$arch\",\"runner\":\"$runner\"},"
        builds="$builds{\"version\":\"$v\",\"arch\":\"$arch\",\"runner\":\"$runner\",\"variant\":\"min3\",\"tagsuffix\":\"\"},"
        if [ "${v%%.*}" -ge 17 ]; then
            builds="$builds{\"version\":\"$v\",\"arch\":\"$arch\",\"runner\":\"$runner\",\"variant\":\"min3full\",\"tagsuffix\":\"-full\"},"
        fi
    done
done
builds="[${builds%,}]"
refs="[${refs%,}]"
tests=""
for img in plain compressed; do
    # the same entries, each with the image kind
    tests="$tests$(printf '%s' "$builds" | sed -e 's/^\[//' -e 's/\]$//' -e "s/}/,\"image\":\"$img\"}/g"),"
done
tests="[${tests%,}]"
echo "builds=$builds"
echo "refs=$refs"
echo "tests=$tests"
