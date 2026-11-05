#!/bin/sh
# The matrices of the image jobs of ci.yml, as JSON, for a list of releases.
#   sh scripts/builds.sh '["9.2.5","9.2.6"]'      prints  builds=...  and  tests=...  (lines for $GITHUB_OUTPUT)
# builds: one entry per release and architecture   {"version":"9.2.5","arch":"amd64","runner":"ubuntu-24.04"}
# tests:  the same, once per image kind (plain, compressed) for the test-image job
# A release gets an arm64 entry when scripts/has-arm64.sh says so; arm64 is built and tested natively on an arm64 runner.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
list=$(printf '%s' "${1:?usage: builds.sh '[\"9.2.5\"]'}" | tr -d '[]" ' | tr ',' ' ')
builds=""
for v in $list; do
    builds="$builds{\"version\":\"$v\",\"arch\":\"amd64\",\"runner\":\"ubuntu-24.04\"},"
    if sh "$here/has-arm64.sh" "$v"; then builds="$builds{\"version\":\"$v\",\"arch\":\"arm64\",\"runner\":\"ubuntu-24.04-arm\"},"; fi
done
builds="[${builds%,}]"
tests=""
for img in plain compressed; do
    # the same entries, each with the image kind
    tests="$tests$(printf '%s' "$builds" | sed -e 's/^\[//' -e 's/\]$//' -e "s/}/,\"image\":\"$img\"}/g"),"
done
tests="[${tests%,}]"
echo "builds=$builds"
echo "tests=$tests"
