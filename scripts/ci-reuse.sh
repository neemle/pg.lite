#!/bin/sh
# Finds an earlier successful run of ci.yml that built and tested THE SAME FILES as the checked-out commit, and prints its id (nothing
# when there is none). A merge of a tested branch, a tag on the merge, or a commit that only changes documentation is a new commit
# with the same files: its build is the one that was tested, so it is reused instead of built again.
#   GH_TOKEN=... GITHUB_REPOSITORY=owner/name sh scripts/ci-reuse.sh <version>...
# "The same files": the same content of every file except the documentation (*.md and LICENSE), compared by a hash of the file list
# with the blob ids (not by the commit or the tree id, which a README change would alter). A run counts only when it succeeded and
# still has the artifacts of every given version (image-<version> and pg.lite-wasm-<version>; they expire after the retention time).
# Needs git with the history of the other branches (actions/checkout with fetch-depth 0) and the gh command (on the runners).
# On any trouble (no history, the API does not answer) it prints nothing: the caller then builds, which is always correct.
set -eu
[ $# -gt 0 ] || { echo "usage: ci-reuse.sh <version>..." >&2; exit 2; }
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

# the id of the files of a commit
files_id() {
    git ls-tree -r "$1" | awk -F'\t' '$2 !~ /\.md$/ && $2 != "LICENSE"' | sha256sum | cut -d' ' -f1
}

here=$(files_id HEAD)
runs=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?status=success&per_page=100" --jq '.workflow_runs[] | "\(.id) \(.head_sha)"') || {
    echo "ci-reuse: the runs cannot be listed, so nothing is reused" >&2
    exit 0
}

printf '%s\n' "$runs" | while read -r id sha; do
    [ -n "$id" ] || continue
    git cat-file -e "$sha^{commit}" 2>/dev/null || continue          # a commit we do not have (deleted branch): cannot compare
    [ "$(files_id "$sha")" = "$here" ] || continue
    names=$(gh api "repos/$repo/actions/runs/$id/artifacts?per_page=100" --jq '.artifacts[] | select(.expired | not) | .name') || continue
    complete=1
    for v in "$@"; do
        printf '%s\n' "$names" | grep -qx "image-$v" || complete=0
        printf '%s\n' "$names" | grep -qx "pg.lite-wasm-$v" || complete=0
    done
    [ "$complete" = 1 ] || continue
    echo "ci-reuse: run $id (commit $sha) built and tested the same files" >&2
    echo "$id"
    break
done
