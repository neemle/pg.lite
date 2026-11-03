#!/bin/sh
# Usage: check-no-pg-source.sh [repo-root]
# Fails if a PostgreSQL source tree is tracked or would be added (untracked, not ignored).
# Upstream is fetched at build time into ignored directories; it must never be committed.
root="${1:-.}"

# Paths that only exist in a PostgreSQL source tree.
pattern='^(src/backend/|src/include/postgres\.h$|src/bin/initdb/|src/interfaces/libpq/|src/pl/plpgsql/|configure\.ac$|configure\.in$)'

if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
    hits=$(git -C "$root" ls-files --cached --others --exclude-standard | grep -E "$pattern" | head -n 20)
else
    # Inside the project container only tools/, patches/ and demo/ are mounted, not the repository root (no .git there):
    # look at the files themselves, skipping the volumes that hold fetched sources and builds.
    hits=$(cd "$root" && find . \( -path ./cache -o -path ./build -o -path ./.work -o -name node_modules \) -prune -o -type f -print | sed 's#^\./##' \
        | grep -E '(^|/)(src/backend/|src/include/postgres\.h$|src/bin/initdb/|src/interfaces/libpq/|src/pl/plpgsql/|configure\.ac$|configure\.in$)' | head -n 20)
fi
if [ -n "$hits" ]; then
    echo "check-no-pg-source: FAIL - PostgreSQL source paths found (first 20):" >&2
    echo "$hits" >&2
    echo "Fetch upstream at build time into an ignored directory (see .gitignore); do not commit it." >&2
    exit 1
fi
echo "check-no-pg-source: PASS"
