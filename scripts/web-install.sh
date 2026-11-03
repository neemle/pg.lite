#!/bin/sh
# Install the npm dependencies of a web project into the build volume (fast, and nothing lands in the repo):
#   tools/dcb web sh scripts/web-install.sh tests/browser      -> /w/build/node/tests-browser/node_modules
#   tools/dcb web sh scripts/web-install.sh web/demo
# Uses package-lock.json when the project has one ("npm ci": exact, integrity-checked versions); otherwise
# resolves the versions, installs them and copies the generated package-lock.json back next to package.json to be
# committed. Needs the network (tools/dcb enables it for nothing but fetch: run with DC_NET=1).
set -eu
dir="${1:?usage: web-install.sh <project dir relative to the repo>}"
work="/w/build/node/$(echo "$dir" | tr '/' '-')"
mkdir -p "$work"
cp "/w/$dir/package.json" "$work/"
if [ -f "/w/$dir/package-lock.json" ]; then
    cp "/w/$dir/package-lock.json" "$work/"
    (cd "$work" && npm ci --no-audit --no-fund)
else
    (cd "$work" && npm install --no-audit --no-fund && cp package-lock.json "/w/$dir/package-lock.json")
    echo "web-install: wrote $dir/package-lock.json (commit it)"
fi
echo "web-install: $work/node_modules ready"
