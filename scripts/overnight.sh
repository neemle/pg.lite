#!/bin/sh
# overnight.sh - build and test releases one after another, unattended. No AI, no prompts: it only runs ../../builder.sh and keeps score.
#
#   tools/scripts/overnight.sh [options]            (from a POSIX shell: Git Bash, WSL, Linux, macOS)
#
#   --versions SPEC   all (default), newest (the newest release of every major), or a comma list: 12.22,9.6.24,17 (a bare major = all of it)
#   --targets LIST    cli, wasm or cli,wasm (default both)
#   --hours N         stop starting new work after N hours (default 8, 0 = no limit); what is running is finished first
#   --order O         spread (default: newest and oldest of every major first, then bisection) or ascending
#   --shard K/N       take every Nth release from the Kth, to split the list over N machines
#   --client C        official (default): the cli tests use the postgres:18-alpine client image; source: build the unmodified upstream
#                     release of each version as the client (much slower; the cli test then needs no CLIENT_IMAGE)
#   --step-hours N    kill one build or test that takes longer than N hours (default 3)
#   --retry-failed    run again what failed in an earlier run (by default a failure is recorded and skipped)
#   --keep            keep archives, images and build trees of finished releases (by default they are removed to bound the disk)
#   --dry-run         print the plan and stop
#   --report-only     build nothing: only write the Markdown report from the results recorded so far
#
# The long run over every release (9.0.0 to the newest, image and WebAssembly, no time limit, a few days) is
#   FETCH_HTTP_FALLBACK=1 tools/scripts/overnight.sh --hours 0
# and it ends with a Markdown report, tools/reports/overnight/report.md (written also when the run is interrupted).
#
# What it does for every release and target, in the order of the list:  builder.sh build <v> <t>  then  builder.sh test <v> <t>.
# A step that fails only for a network reason (download, npm) is tried once more after a minute. After each release the build trees,
# the image or archive and the source download are removed. Everything is resumable: results are appended to
# tools/reports/overnight/results.tsv (time, release, target, step, ok|fail|timeout, seconds, log), and what is already ok is skipped, so
# the same command can be started every night until the list is done. Logs: tools/reports/overnight/logs/<release>-<target>-<step>.log.
# A summary is printed and written to tools/reports/overnight/summary.txt.
# Behind a TLS-inspecting proxy that breaks downloads, start it as   FETCH_HTTP_FALLBACK=1 tools/scripts/overnight.sh ...
# The machine must not sleep: on Windows use "powercfg /change standby-timeout-ac 0" or keep Docker Desktop and the shell awake yourself.
set -u
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root" || exit 1

versions=all; targets=cli,wasm; hours=8; order=spread; shard=1/1; client=official; step_hours=3; retry=0; keep=0; dry=0; report_only=0
while [ $# -gt 0 ]; do
    case "$1" in
        --versions) versions="${2:?--versions needs a value}"; shift ;;
        --targets) targets="${2:?--targets needs a value}"; shift ;;
        --hours) hours="${2:?--hours needs a value}"; shift ;;
        --order) order="${2:?--order needs a value}"; shift ;;
        --shard) shard="${2:?--shard needs K/N}"; shift ;;
        --client) client="${2:?--client needs official or source}"; shift ;;
        --step-hours) step_hours="${2:?--step-hours needs a value}"; shift ;;
        --retry-failed) retry=1 ;;
        --keep) keep=1 ;;
        --dry-run) dry=1 ;;
        --report-only) report_only=1 ;;
        -h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "overnight: unknown option $1 (--help)" >&2; exit 2 ;;
    esac
    shift
done
case "$client" in official|source) ;; *) echo "overnight: --client is official or source" >&2; exit 2 ;; esac
for t in $(echo "$targets" | tr ',' ' '); do case "$t" in cli|wasm) ;; *) echo "overnight: unknown target $t" >&2; exit 2 ;; esac; done

out=tools/reports/overnight
mkdir -p "$out/logs"
results="$out/results.tsv"
[ -f "$results" ] || printf 'time\trelease\ttarget\tstep\tstatus\tseconds\tlog\n' > "$results"

# the Markdown report: in the tools container, or with a node on the host when docker is not reachable
write_report() {
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then tools/dc node scripts/overnight-report.js >/dev/null
    elif command -v node >/dev/null 2>&1; then node tools/scripts/overnight-report.js >/dev/null
    else echo "overnight: no docker and no node, cannot write the report" >&2; return 1; fi
    echo "overnight: report: $out/report.md"
}
if [ "$report_only" = 1 ]; then write_report; exit $?; fi

list=$(tools/dc node scripts/overnight-order.js --versions "$versions" --order "$order" --shard "$shard") || exit 2
total=$(echo "$list" | grep -c .)
echo "overnight: $total release(s), targets $targets, up to $hours h, order $order, shard $shard, client $client"
if [ "$dry" = 1 ]; then echo "$list" | tr '\n' ' '; echo; exit 0; fi

command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || { echo "overnight: docker is not reachable" >&2; exit 1; }
lock="$out/.lock"
mkdir "$lock" 2>/dev/null || { echo "overnight: another run is active (or died: remove $lock)" >&2; exit 1; }
trap 'rmdir "$lock" 2>/dev/null; write_report' EXIT
trap 'exit 130' INT TERM

if [ "$client" = official ]; then
    export CLIENT_IMAGE="${CLIENT_IMAGE:-postgres:18-alpine}"
    docker image inspect "$CLIENT_IMAGE" >/dev/null 2>&1 || docker pull "$CLIENT_IMAGE" >/dev/null 2>&1 || echo "overnight: warning: could not pull $CLIENT_IMAGE; cli tests need it" >&2
else
    unset CLIENT_IMAGE
fi

now() { date +%s; }
stamp() { date +%Y-%m-%dT%H:%M:%S; }
start=$(now)
deadline=$((start + $(awk -v h="$hours" 'BEGIN { printf "%d", h * 3600 }')))
[ "$hours" = 0 ] && deadline=9999999999

# last recorded status of a release/target/step ('' when none)
last_status() { awk -F'\t' -v r="$1" -v t="$2" -v s="$3" '$2 == r && $3 == t && $4 == s { st = $5 } END { print st }' "$results"; }

run_step() { # release target step -> 0 ok, 1 failed
    r=$1; t=$2; s=$3
    log="$out/logs/$r-$t-$s.log"
    begin=$(now)
    attempt=1; rc=1
    while [ "$attempt" -le 2 ]; do
        if command -v timeout >/dev/null 2>&1; then
            timeout "${step_hours}h" ./builder.sh "$s" "$r" "$t" > "$log" 2>&1; rc=$?
        else
            ./builder.sh "$s" "$r" "$t" > "$log" 2>&1; rc=$?
        fi
        [ "$rc" = 0 ] && break
        [ "$rc" = 124 ] && break
        # a failure that is the network's (download, registry), not the build's, gets one more try after a minute
        if [ "$attempt" = 1 ] && grep -qiE 'curl: \(|could not resolve|connection (reset|refused|timed out)|tls|ECONNRESET|ETIMEDOUT|EAI_AGAIN|temporary failure' "$log"; then
            echo "overnight:   $r $t $s: network trouble, trying once more in a minute"
            sleep 60
            attempt=2
        else
            break
        fi
    done
    status=fail; [ "$rc" = 0 ] && status=ok; [ "$rc" = 124 ] && status=timeout
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(stamp)" "$r" "$t" "$s" "$status" "$(( $(now) - begin ))" "$log" >> "$results"
    echo "overnight: $(stamp) $r $t $s: $status ($(( $(now) - begin )) s)"
    [ "$status" = ok ]
}

clean_target() { # release target
    [ "$keep" = 1 ] && return 0
    case "$2" in
        cli) tools/dc sh -c "rm -rf build/native/$1 build/native/$1-*" >/dev/null 2>&1
             docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E "^compactdb-native:$1(-|$)" | xargs -r docker rmi -f >/dev/null 2>&1 ;;
        wasm) tools/dc sh -c "rm -rf build/wasm/$1 dist/compact-db-wasm-$1.*" >/dev/null 2>&1 ;;
    esac
}
clean_release() { # release
    [ "$keep" = 1 ] && return 0
    tools/dc sh -c "rm -rf cache/src/$1 cache/downloads/postgresql-$1.tar.bz2" >/dev/null 2>&1
    docker image prune -f >/dev/null 2>&1
}

n=0; stopped=0
for r in $list; do
    n=$((n + 1))
    for t in $(echo "$targets" | tr ',' ' '); do
        if [ "$(now)" -ge "$deadline" ]; then stopped=1; break 2; fi
        b=$(last_status "$r" "$t" build); x=$(last_status "$r" "$t" test)
        if [ "$b" = ok ] && [ "$x" = ok ]; then continue; fi
        if [ "$retry" = 0 ] && { [ "$b" = fail ] || [ "$b" = timeout ] || [ "$x" = fail ] || [ "$x" = timeout ]; }; then
            echo "overnight: $r $t failed in an earlier run, skipped (--retry-failed to try again)"; continue
        fi
        echo "overnight: [$n/$total] $r $t"
        if run_step "$r" "$t" build; then run_step "$r" "$t" test; fi
        clean_target "$r" "$t"
    done
    clean_release "$r"
done

# ---- summary
{
    echo "overnight summary ($(stamp)), $(( ($(now) - start) / 60 )) minutes this run$([ "$stopped" = 1 ] && echo ", stopped by the time limit")"
    for t in $(echo "$targets" | tr ',' ' '); do
        ok=0; bad=0; todo=0
        for r in $list; do
            b=$(last_status "$r" "$t" build); x=$(last_status "$r" "$t" test)
            if [ "$b" = ok ] && [ "$x" = ok ]; then ok=$((ok + 1))
            elif [ "$b" = fail ] || [ "$b" = timeout ] || [ "$x" = fail ] || [ "$x" = timeout ]; then bad=$((bad + 1))
            else todo=$((todo + 1)); fi
        done
        echo "  $t: $ok built and tested ok, $bad failed, $todo not run yet (of $total)"
    done
    awk -F'\t' 'NR > 1 { k = $2 "\t" $3 "\t" $4; st[k] = $5; lg[k] = $7 } END { for (k in st) if (st[k] != "ok") { split(k, a, "\t"); print "  FAILED " a[1] " " a[2] " " a[3] " (" st[k] "): " lg[k] } }' "$results" | sort -V
} | tee "$out/summary.txt"
