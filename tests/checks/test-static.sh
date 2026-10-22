#!/bin/sh
# Positive and negative tests for scripts/check-static.sh. Needs gcc and readelf, so it runs in
# the musl builder:   ./dcb musl make test-check-static
set -u
here=$(cd "$(dirname "$0")" && pwd)
tool="$here/../../scripts/check-static.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0
ok() { echo "PASS $*"; }
no() { echo "FAIL $*"; fail=1; }

cat > "$tmp/hello.c" <<'EOF'
#include <stdio.h>
int main(void) { puts("hi"); return 0; }
EOF
cat > "$tmp/lib.c" <<'EOF'
int answer(void) { return 42; }
EOF

mkdir -p "$tmp/good" "$tmp/unstripped" "$tmp/dynamic" "$tmp/so" "$tmp/text" "$tmp/empty"
gcc -O2 -static "$tmp/hello.c" -o "$tmp/good/hello" && strip --strip-all "$tmp/good/hello"
gcc -O2 -g -static "$tmp/hello.c" -o "$tmp/unstripped/hello"
gcc -O2 "$tmp/hello.c" -o "$tmp/dynamic/hello"
gcc -O2 -shared -fPIC "$tmp/lib.c" -o "$tmp/so/libanswer.so" && strip --strip-unneeded "$tmp/so/libanswer.so"
echo "just text" > "$tmp/text/readme.txt"

run() { sh "$tool" "$@" >"$tmp/out.txt" 2>&1; echo $?; }

[ "$(run "$tmp/good")" = 0 ] && ok "static stripped binary passes" || { no "static stripped binary rejected"; cat "$tmp/out.txt"; }
c=$(run "$tmp/dynamic"); { [ "$c" = 1 ] && grep -q 'PT_INTERP' "$tmp/out.txt" && grep -q 'DT_NEEDED' "$tmp/out.txt"; } && ok "dynamic binary fails with PT_INTERP and DT_NEEDED" || no "dynamic binary not flagged ($c)"
c=$(run "$tmp/unstripped"); { [ "$c" = 1 ] && grep -q 'not-stripped' "$tmp/out.txt"; } && ok "unstripped static binary fails" || no "unstripped binary not flagged ($c)"
[ "$(run --allow-unstripped "$tmp/unstripped")" = 0 ] && ok "--allow-unstripped accepts the unstripped static binary" || no "--allow-unstripped did not accept it"
c=$(run "$tmp/so"); { [ "$c" = 1 ] && grep -q 'shared-object-file' "$tmp/out.txt"; } && ok "a shared object in the runtime fails" || no "shared object not flagged ($c)"
c=$(run "$tmp/empty"); [ "$c" = 2 ] && ok "a directory with no ELF is an error, not a pass" || no "empty dir gave $c"
c=$(run "$tmp/text"); [ "$c" = 2 ] && ok "non-ELF files are skipped and an all-text dir is an error" || no "text dir gave $c"
c=$(run "$tmp/good" "$tmp/dynamic"); [ "$c" = 1 ] && ok "one bad file among good ones fails the run" || no "mixed set gave $c"
c=$(run "$tmp/doesnotexist"); [ "$c" = 2 ] && ok "a missing path is an error" || no "missing path gave $c"

sh "$tool" --json "$tmp/r.json" "$tmp/good" "$tmp/dynamic" >/dev/null 2>&1
{ grep -q '"ok":false' "$tmp/r.json" && grep -q '"checked":2' "$tmp/r.json" && grep -q '"failed":1' "$tmp/r.json"; } && ok "JSON result records the counts and the failure" || { no "JSON result wrong"; cat "$tmp/r.json"; }
sh "$tool" --json "$tmp/r2.json" "$tmp/good" >/dev/null 2>&1
grep -q '"ok":true' "$tmp/r2.json" && ok "JSON result is ok:true for a clean set" || no "clean JSON wrong"

exit $fail
