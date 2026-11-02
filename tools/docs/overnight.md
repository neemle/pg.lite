# Unattended runs: does every release build?

`tools/scripts/overnight.sh` builds and tests releases one after another with no one watching. It only calls `builder.sh` (so it
tests exactly what CI tests), keeps a table of results, cleans up after each release and can be started again every night until the
list is done. No AI, no prompts.

```sh
FETCH_HTTP_FALLBACK=1 tools/scripts/overnight.sh                    # everything, up to 8 hours, then stops and summarises
tools/scripts/overnight.sh --hours 10 --targets cli                 # only the static image
tools/scripts/overnight.sh --versions newest                        # the newest release of every major (16 releases)
tools/scripts/overnight.sh --versions 12,9.6.24 --targets cli,wasm  # a whole major and one release
tools/scripts/overnight.sh --shard 1/3                              # a third of the list; run 2/3 and 3/3 on other machines
tools/scripts/overnight.sh --dry-run                                # print the list and stop
tools/scripts/overnight.sh --hours 0                                # no time limit: all 351 releases, image and WebAssembly, until done
tools/scripts/overnight.sh --report-only                            # build nothing, only write tools/reports/overnight/report.md
```

Run it from a POSIX shell (Git Bash, WSL, Linux, macOS) with Docker running. `--help` lists every option.

## How long it takes

One release is a full PostgreSQL build plus the tests, per target. As a rough guide, with the default settings the static image
(`cli`) takes a few tens of minutes per release and the WebAssembly build (`wasm`, with the Chromium tests) somewhat longer; the first
release also builds the builder images. All 351 releases for both targets is therefore a matter of days, not one night. That is why
the run is built to be repeated: it keeps going where the last run stopped, in an order that finds problems early.

* **Order** (`--order spread`, the default): the newest and the oldest release of every major first, then the middle ones by repeated
  bisection, majors taking turns. After the first hours you have already built very different releases; a problem in the patches of
  some span of releases shows up early. `--order ascending` goes 9.0.0, 9.0.1, ...
* **Time limit** (`--hours`): no new release is started after the limit; the one running is finished.
* **Resume**: every step is appended to `tools/reports/overnight/results.tsv`. A release and target whose build and test are both `ok` is
  skipped on the next run. A failure is recorded and skipped too, so one broken release does not eat every night; `--retry-failed` tries
  those again.
* **Split over machines**: `--shard K/N` takes every Nth release of the ordered list.

## What it does for each release and target

1. `builder.sh build <release> <target>`, then, if that worked, `builder.sh test <release> <target>`. A step is killed after
   `--step-hours` (default 3) and recorded as `timeout`.
2. A step that fails only because of the network (a download, npm) is tried once more after a minute.
3. The build trees, the image or archive and the source download of the release are removed (`--keep` keeps them), so the disk and the
   Docker volumes do not fill up over a night.

The cli tests need a `psql` client. By default the run uses the `postgres:18-alpine` image for every release (`--client official`),
which is what the earlier manual runs used and which talks to every release back to 9.0. `--client source` builds the unmodified
upstream release of each version as the client instead: more faithful, much slower.

## Reading the result

* `tools/reports/overnight/report.md`: the Markdown report, written when the run ends, is interrupted or is asked for with `--report-only`: a verdict, a table per major with build and test of the image and of WebAssembly for every release (status and time), the failures with the log lines that say why, and the time spent. Built by `scripts/overnight-report.js` from the results table.
* `tools/reports/overnight/summary.txt` (also printed at the end): per target how many releases are built and tested ok, failed, or
  not run yet, and the failures with the path of the log.
* `tools/reports/overnight/results.tsv`: one line per step: time, release, target, step, `ok`/`fail`/`timeout`, seconds, log.
* `tools/reports/overnight/logs/<release>-<target>-<step>.log`: the whole output of a step (git-ignored).

## Keeping it running

Docker Desktop and the shell have to stay up for the whole night: disable sleep while on mains power, and do not log off. If the run is
killed, remove `tools/reports/overnight/.lock` and start it again; the table says where it was. Behind a TLS-inspecting proxy that breaks
downloads, start it as `FETCH_HTTP_FALLBACK=1 tools/scripts/overnight.sh ...` (the pinned SHA-256 is still checked).
