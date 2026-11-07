#!/bin/sh
# Host launcher for the native FROM scratch image (it only runs docker).
#   image/image.sh image [version]    assemble the context from build/native/<v> and build compactdb-native:<v>
#   image/image.sh up    [version]    start the server (cold init on an empty volume)
#   image/image.sh psql  [version] -- <psql args>   psql from the reference image over TCP
#   image/image.sh down  [version]    remove the server and its volume
#   image/image.sh test  [version]    SQL smoke, modules, auth, restart, non-empty PGDATA, static check
# Prerequisites (./builder.sh build <v> cli does all of it): tools/dc make native-src VERSION=<v>; tools/dcb musl make native-build VERSION=<v>;
#                image/reference.sh image <v>  (its psql is the external client).
set -eu
root=$(cd "$(dirname "$0")/../tools" && pwd)
cmd="${1:?usage: native-image.sh image|up|psql|down|test [version]}"; shift
ver="${1:-18.6}"; [ $# -gt 0 ] && shift || true
bvs="${VARIANT:+-$VARIANT}"   # size/compiler variant (build/native/<ver>-<variant>), see build-native.sh
# PACK=xsfx compresses every executable with xsfx (LZMA2) when the image is assembled; it gets its own image tag
pack="${PACK:-}"; case "$pack" in ""|xsfx) ;; *) echo "native: PACK must be empty or xsfx" >&2; exit 2 ;; esac
vs="$bvs${pack:+-$pack}"
# the architecture of the docker host (x86_64 or aarch64), which is the one the image is built for: the packer and the label follow it
case "$(docker info --format "{{.Architecture}}" 2>/dev/null)" in aarch64|arm64) arch=arm64; xsfx_arch=aarch64 ;; *) arch=amd64; xsfx_arch=x86_64 ;; esac
xsfx_bin=/b/xsfx/v0.2.0/x/xsfx-$xsfx_arch-unknown-linux-musl
img="compactdb-native:$ver$vs"
client_img="${CLIENT_IMAGE:-compactdb-reference:$ver}"   # the stock psql of a first minor can crash on a current distribution: CLIENT_IMAGE=compactdb-reference:<later minor of the major>
net="compactdb-ref-net"
name="compactdb-native-$ver$vs"
vol="compactdb-native-data-$ver$vs"
builder="compactdb-builder-musl:local"
# Test credential for a throw-away server on a private docker network; not a secret.
pw="native-test-only"
export MSYS_NO_PATHCONV=1

client_one() { docker run --rm --network "$net" -e PGPASSWORD="${CLIENT_PASSWORD:-$pw}" --entrypoint psql "$client_img" -h "$name" -U postgres -v ON_ERROR_STOP=1 "$@"; }
# psql before 9.6 takes a single -c: run one psql per -c (commands are single-line), the other arguments are shared
client() {
    cmds=$(mktemp); common=""; ncmd=0
    while [ $# -gt 0 ]; do
        if [ "$1" = -c ]; then printf '%s
' "$2" >> "$cmds"; ncmd=$((ncmd + 1)); shift 2; else common="$common $1"; shift; fi
    done
    rc=0
    if [ "$ncmd" -le 1 ]; then
        # shellcheck disable=SC2086
        if [ "$ncmd" = 1 ]; then client_one $common -c "$(cat "$cmds")" || rc=$?; else client_one $common || rc=$?; fi
    else
        while IFS= read -r c; do
            # shellcheck disable=SC2086
            client_one $common -c "$c" || { rc=$?; break; }
        done < "$cmds"
    fi
    rm -f "$cmds"
    return $rc
}
wait_ready() {
    i=0
    until client -At -c "SELECT 1" >/dev/null 2>&1; do
        i=$((i + 1)); [ "$i" -gt 90 ] && { echo "native: server did not become ready" >&2; docker logs "$name" >&2; return 1; }
        sleep 1
    done
}

case "$cmd" in
image)
    docker image inspect "$builder" >/dev/null 2>&1 || { echo "native: build the musl builder first (tools/dcb musl make builder-check)" >&2; exit 1; }
    # The image holds ONE file: /usr/local/pgsql/bin/postgres, the server with initdb, the entrypoint and the share/ tree linked in (patch 0006,
    # build/native/<v>/image/postgres). Besides it there are only two empty directories (/tmp, and the data directory the volume mounts over).
    # WITH_TOOLS=1 only changes the tag (the compatibility test asks for the -tools image; the tools are part of the same file).
    tag="$img"; if [ "${WITH_TOOLS:-0}" = 1 ]; then tag="$img-tools"; fi
    # what the labels of the image say: the major (9.0, 10, ...), the commit this was built from and the date of that commit
    major=$(echo "$ver" | awk -F. '{ if ($1 + 0 >= 10) print $1; else print $1 "." $2 }')
    revision=$(cd "$root/.." && git rev-parse HEAD 2>/dev/null || echo unknown)
    created=$(cd "$root/.." && git log -1 --format=%cI 2>/dev/null || echo unknown)
    # the packer is fetched into the build volume (checked against a pinned SHA-256) the first time it is asked for
    if [ "$pack" = xsfx ]; then (unset MSYS_NO_PATHCONV; DC_NET=1 "$root/dc" sh image/fetch-xsfx.sh); fi
    docker run --rm --network none -e VDIR="$ver$bvs" -e PACK="$pack" -e XSFX="$xsfx_bin" -v "${DC_BUILD_VOLUME:-compactdb-build}":/b:ro -v "$root/../image/docker/native:/n:ro" "$builder" sh -c '
         set -e
         bin=/b/native/$VDIR/image/postgres
         test -x $bin || { echo "no one-file build in build/native/$VDIR; run tools/dcb musl make native-build VERSION='"$ver"'" >&2; exit 1; }
         d=$(mktemp -d); r=$d/rootfs
         mkdir -p $r/tmp $r/usr/local/pgsql/bin $d/pgdata
         chmod 1777 $r/tmp
         cp $bin $r/usr/local/pgsql/bin/postgres
         if [ "$PACK" = xsfx ]; then   # pack the executable; keep the packed file only if it is smaller (the stub is 90 KB)
             cp $XSFX /tmp/xsfx; chmod +x /tmp/xsfx
             /tmp/xsfx $r/usr/local/pgsql/bin/postgres /tmp/packed >/dev/null; a=$(stat -c %s $r/usr/local/pgsql/bin/postgres); b=$(stat -c %s /tmp/packed)
             if [ $b -lt $a ]; then cat /tmp/packed > $r/usr/local/pgsql/bin/postgres; echo "native: packed postgres $a -> $b" >&2; else echo "native: kept postgres unpacked ($a; packed would be $b)" >&2; fi
         fi
         cp /n/Dockerfile $d/
         tar -C $d -cf - .' | docker build -q -t "$tag" \
        --build-arg PG_VERSION="$ver" --build-arg PG_MAJOR="$major" \
        --build-arg PG_UID="${PG_UID:-70}" --build-arg PG_GID="${PG_GID:-70}" \
        --build-arg REVISION="$revision" --build-arg CREATED="$created" \
        --build-arg PACKED="$([ -n "$pack" ] && echo yes || echo no)" --build-arg ARCH="$arch" -
    echo "native: built $tag"
    ;;
up)
    docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume create "$vol" >/dev/null
    docker run -d --name "$name" --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol:/var/lib/postgresql/data" "$img" >/dev/null
    wait_ready
    echo "native: $name is ready (network $net)"
    ;;
psql)
    [ "${1:-}" = "--" ] && shift
    client "$@"
    ;;
manifest)
    # Every file in the image with its size, and proof there is no shell, loader or shared object.
    mkdir -p "$root/reports"
    cid=$(docker create "$img" /nonexistent)
    docker export "$cid" | docker run -i --rm --network none --entrypoint tar "$builder" -tvf - > "$root/reports/native-image-files$vs.txt"
    docker rm "$cid" >/dev/null
    # docker adds mount points to every container export (.dockerenv, dev/console, etc/hosts, hostname, resolv.conf); they are not image content
    list="$root/reports/native-image-files$vs.txt"
    skip=' (\.dockerenv|dev/console|etc/(hostname|hosts|resolv\.conf))$'
    files=$(grep '^-' "$list" | grep -cvE "$skip" || true)
    bytes=$(grep '^-' "$list" | grep -vE "$skip" | awk '{s += $3} END {print s + 0}')
    echo "native: $files files, $bytes bytes (reports/native-image-files$vs.txt)"
    if grep -E ' (usr/)?(local/)?(bin|sbin)/(sh|bash|ash|busybox)$|ld-musl|ld-linux|\.so(\.[0-9]+)*$' "$root/reports/native-image-files$vs.txt"; then
        echo "FAIL: shell, dynamic loader or shared object found in the image"; exit 1
    fi
    [ "$files" = 1 ] && echo "PASS: the image holds exactly one file" || { echo "FAIL: expected one file in the image, found $files"; exit 1; }
    echo "PASS: no shell, no dynamic loader, no shared object in the image"
    ;;
down)
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm "$vol" >/dev/null 2>&1 || true
    echo "native: removed $name and $vol"
    ;;
test)
    # an external client (CLIENT_IMAGE, for example postgres:9.5-alpine) is pulled when it is not there yet
    docker image inspect "$client_img" >/dev/null 2>&1 || docker pull -q "$client_img" >/dev/null 2>&1 || { echo "native: build the reference image first (image/reference.sh image $ver)" >&2; exit 1; }
    trap 'sh "$0" down "$ver" >/dev/null 2>&1 || true; docker volume rm "$vol-bad" >/dev/null 2>&1 || true' EXIT
    fail=0
    pass() { echo "PASS $*"; }
    bad() { echo "FAIL $*"; fail=1; }
    sh "$0" down "$ver" >/dev/null 2>&1 || true

    echo "--- image metadata: user, environment, volume, port, stop signal, labels"
    insp() { docker image inspect "$img" --format "$1"; }
    [ "$(insp '{{.Config.User}}')" = "${PG_UID:-70}:${PG_GID:-70}" ] && pass "the image runs as ${PG_UID:-70}:${PG_GID:-70}" || bad "user: $(insp '{{.Config.User}}')"
    insp '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx "PGDATA=/var/lib/postgresql/data" && pass "ENV PGDATA" || bad "no PGDATA in the environment"
    insp '{{range .Config.Env}}{{println .}}{{end}}' | grep -qx "PG_VERSION=$ver" && pass "ENV PG_VERSION=$ver" || bad "PG_VERSION missing or wrong"
    insp '{{range .Config.Env}}{{println .}}{{end}}' | grep -q "^PG_MAJOR=." && pass "ENV PG_MAJOR" || bad "PG_MAJOR missing"
    [ "$(insp '{{json .Config.Volumes}}')" = '{"/var/lib/postgresql/data":{}}' ] && pass "VOLUME /var/lib/postgresql/data" || bad "volumes: $(insp '{{json .Config.Volumes}}')"
    [ "$(insp '{{json .Config.ExposedPorts}}')" = '{"5432/tcp":{}}' ] && pass "EXPOSE 5432" || bad "ports: $(insp '{{json .Config.ExposedPorts}}')"
    [ "$(insp '{{.Config.StopSignal}}')" = "SIGINT" ] && pass "STOPSIGNAL SIGINT (fast shutdown)" || bad "stop signal: $(insp '{{.Config.StopSignal}}')"
    rev=$(insp '{{index .Config.Labels "org.opencontainers.image.revision"}}')
    echo "$rev" | grep -Eq '^[0-9a-f]{40}$' && pass "label revision is the commit ($rev)" || bad "label revision is not a commit: $rev"
    for l in title description version revision created source licenses; do
        v=$(insp "{{index .Config.Labels \"org.opencontainers.image.$l\"}}")
        { [ -n "$v" ] && [ "$v" != "<no value>" ]; } || bad "label org.opencontainers.image.$l is missing"
    done
    [ "$(insp '{{index .Config.Labels "org.opencontainers.image.version"}}')" = "$ver" ] && [ "$(insp '{{index .Config.Labels "org.opencontainers.image.licenses"}}')" = "PostgreSQL" ] && pass "OCI labels: title, description, version=$ver, revision, created, source, licenses=PostgreSQL" || bad "labels do not match"

    echo "--- cold init in the scratch image on an empty volume, as uid ${PG_UID:-70} (no shell, no .so)"
    sh "$0" up "$ver"
    [ "$(client -At -c 'SELECT 1')" = "1" ] && pass "SELECT 1 from an external client over TCP" || bad "SELECT 1"
    client -At -c "SELECT version()" -c "SHOW server_encoding" -c "SHOW timezone" -c "SELECT datcollate FROM pg_database WHERE datname='postgres'"
    # the locale provider column exists from 15 on
    client -At -c "SELECT datlocprovider::text FROM pg_database WHERE datname='postgres'" 2>/dev/null || echo "(this release has no locale provider column)"

    echo "--- built-in modules (no dlopen)"
    out=$(client -At -c "CREATE FUNCTION f(x int) RETURNS int LANGUAGE plpgsql AS \$\$ BEGIN RETURN x + 1; END \$\$" -c "SELECT f(41)" 2>&1) && [ "$(echo "$out" | tail -1)" = "42" ] && pass "plpgsql function runs" || { bad "plpgsql: $out"; }
    out=$(client -At -c "SELECT to_tsvector('english', 'The quick brown foxes jumped')" 2>&1) && echo "$out" | grep -q "fox" && pass "snowball text search stems (foxes -> fox)" || bad "snowball: $out"

    cfgs=$(client -At -c "SELECT string_agg(cfgname, ',' ORDER BY cfgname) FROM pg_ts_config" 2>&1)
    case ",$cfgs," in *,english,*,german,*,russian,*) pass "text search configurations of every language: $(echo "$cfgs" | tr ',' '\n' | wc -l) ($cfgs)" ;; *) bad "text search configurations missing: $cfgs" ;; esac
    out=$(client -At -c "SELECT to_tsvector('german', 'Die Häuser')" 2>&1) && echo "$out" | grep -q "'haus'" && pass "German text search stems Häuser to haus" || bad "german: $out"

    echo "--- encoding conversions (linked in, no dlopen)"
    out=$(client -At -c "SELECT convert_to('é', 'LATIN1')" 2>&1)
    [ "$out" = '\xe9' ] && pass "UTF8 to LATIN1 converts" || bad "latin1: $out"
    out=$(client -At -c "SELECT convert_from(convert_to('Привіт світе', 'WIN1251'), 'WIN1251')" 2>&1)
    [ "$out" = 'Привіт світе' ] && pass "UTF8 to WIN1251 and back" || bad "win1251: $out"
    out=$(client -At -c "SELECT convert_from(convert_to('日本語', 'EUC_JP'), 'EUC_JP')" 2>&1)
    [ "$out" = '日本語' ] && pass "UTF8 to EUC_JP and back" || bad "euc_jp: $out"
    out=$(client -At -c "SELECT convert_from(convert_to('한국어', 'EUC_KR'), 'EUC_KR'), octet_length(convert_to('中文', 'GB18030'))" 2>&1)
    [ "$out" = '한국어|4' ] && pass "UTF8 to EUC_KR and back; GB18030 takes 2 bytes a character" || bad "euc_kr, gb18030: $out"

    echo "--- missing module gives a clear error and the server survives"
    out=$(client -At -c "LOAD 'does_not_exist'" 2>&1 || true)
    echo "$out" | grep -q "statically linked" && pass "LOAD of an unknown library: clear error ($out)" || bad "unexpected LOAD result: $out"
    [ "$(client -At -c 'SELECT 1')" = "1" ] && pass "server still answers after the failed LOAD" || bad "server died"

    echo "--- authentication"
    if CLIENT_PASSWORD=wrong client -At -c "SELECT 1" >/dev/null 2>&1; then bad "wrong password accepted"; else pass "wrong SCRAM password rejected"; fi

    echo "--- restart keeps data (same volume, no re-init)"
    client -At -c "CREATE TABLE t(x int)" -c "INSERT INTO t VALUES (42)" >/dev/null
    docker restart "$name" >/dev/null
    wait_ready
    [ "$(client -At -c 'SELECT x FROM t')" = "42" ] && pass "data survived restart" || bad "data lost on restart"
    docker logs "$name" 2>&1 | grep -c "database system is ready to accept connections" | grep -q . && pass "server logged readiness"

    echo "--- non-empty, non-cluster PGDATA is refused and left alone"
    docker volume create "$vol-bad" >/dev/null
    docker run --rm -v "$vol-bad:/d" --user 0 --entrypoint "" "$builder" sh -c 'echo precious > /d/keep.txt; chown -R 70:70 /d' >/dev/null
    set +e
    docker run --rm --name "$name-bad" -e POSTGRES_PASSWORD="$pw" -v "$vol-bad:/var/lib/postgresql/data" "$img" 2>"$name.err" >/dev/null
    rc=$?
    set -e
    still=$(docker run --rm -v "$vol-bad:/d" --entrypoint "" "$builder" sh -c 'cat /d/keep.txt; ls /d | wc -l' | tr '\n' ' ')
    { [ "$rc" = 1 ] && [ "$still" = "precious 1 " ]; } && pass "refused (exit 1), file kept, nothing created" || bad "bad PGDATA handling: rc=$rc contents=$still"
    rm -f "$name.err"

    echo "--- the environment of the official postgres image (https://hub.docker.com/_/postgres)"
    envname="$name-env"
    # envq <user> <password> <database> <sql>: one value, as that user, from an external client
    envq() { docker run --rm --network "$net" -e PGPASSWORD="$2" --entrypoint psql "$client_img" -h "$envname" -U "$1" -d "$3" -At -c "$4" 2>&1; }
    env_wait() { i=0; until envq "$1" "$2" "$3" 'SELECT 1' >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -gt 60 ] && return 1; sleep 1; done; }
    env_clean() { docker rm -f "$envname" >/dev/null 2>&1 || true; docker volume rm -f "$vol-env" "$vol-wal" "$vol-sec" >/dev/null 2>&1 || true; }
    env_clean
    docker volume create "$vol-env" >/dev/null
    docker volume create "$vol-sec" >/dev/null
    docker volume create "$vol-wal" >/dev/null
    docker run --rm --user 0 -v "$vol-wal:/wal" --entrypoint "" "$builder" chown 70:70 /wal
    docker run --rm -v "$vol-sec:/s" --entrypoint "" "$builder" sh -c 'printf "file-secret\n" > /s/pw; printf "fileuser" > /s/user; printf "filedb" > /s/db; chmod 644 /s/*'

    # POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_INITDB_ARGS, POSTGRES_INITDB_WALDIR
    docker run -d --name "$envname" --network "$net" -e POSTGRES_USER=app -e POSTGRES_PASSWORD=s3cret -e POSTGRES_DB=appdb \
        -e POSTGRES_INITDB_ARGS="--lc-collate=C" -e POSTGRES_INITDB_WALDIR=/wal \
        -v "$vol-env:/var/lib/postgresql/data" -v "$vol-wal:/wal" "$img" >/dev/null
    if env_wait app s3cret appdb; then
        [ "$(envq app s3cret appdb "SELECT current_user || '|' || current_database()")" = "app|appdb" ] && pass "POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB" || bad "user/db: $(envq app s3cret appdb 'SELECT current_user, current_database()')"
        [ "$(envq app s3cret appdb "SELECT count(*) FROM pg_database WHERE datname IN ('postgres', 'appdb')")" = "2" ] && pass "the default database postgres is there too" || bad "databases"
        [ "$(envq app s3cret appdb 'SHOW lc_collate')" = "C" ] && pass "POSTGRES_INITDB_ARGS reach initdb (--lc-collate=C)" || bad "initdb args: $(envq app s3cret appdb 'SHOW lc_collate')"
        link=$(docker run --rm -v "$vol-env:/d:ro" --entrypoint "" "$builder" sh -c 'readlink /d/pg_wal || readlink /d/pg_xlog')
        [ "$link" = "/wal" ] && pass "POSTGRES_INITDB_WALDIR: the WAL directory is a link to /wal" || bad "waldir link: '$link'"
        envq app wrong appdb 'SELECT 1' | grep -q "authentication failed" && pass "a wrong password is rejected" || bad "wrong password accepted"
    else
        bad "POSTGRES_USER/PASSWORD/DB container did not come up: $(docker logs "$envname" 2>&1 | tail -n 5)"
    fi
    env_clean

    # the _FILE variants (Docker secrets)
    docker volume create "$vol-env" >/dev/null
    docker volume create "$vol-sec" >/dev/null
    docker run --rm -v "$vol-sec:/s" --entrypoint "" "$builder" sh -c 'printf "file-secret\n" > /s/pw; printf "fileuser" > /s/user; printf "filedb" > /s/db; chmod 644 /s/*'
    docker run -d --name "$envname" --network "$net" -e POSTGRES_USER_FILE=/run/secrets/user -e POSTGRES_PASSWORD_FILE=/run/secrets/pw \
        -e POSTGRES_DB_FILE=/run/secrets/db -v "$vol-env:/var/lib/postgresql/data" -v "$vol-sec:/run/secrets:ro" "$img" >/dev/null
    if env_wait fileuser file-secret filedb; then
        [ "$(envq fileuser file-secret filedb "SELECT current_user || '|' || current_database()")" = "fileuser|filedb" ] && pass "POSTGRES_USER_FILE, POSTGRES_PASSWORD_FILE and POSTGRES_DB_FILE" || bad "_FILE variants"
    else
        bad "_FILE container did not come up: $(docker logs "$envname" 2>&1 | tail -n 5)"
    fi
    env_clean

    # POSTGRES_HOST_AUTH_METHOD=trust: no password needed
    docker volume create "$vol-env" >/dev/null
    docker run -d --name "$envname" --network "$net" -e POSTGRES_HOST_AUTH_METHOD=trust -v "$vol-env:/var/lib/postgresql/data" "$img" >/dev/null
    if env_wait postgres "" postgres; then
        [ "$(envq postgres "" postgres 'SELECT 42')" = "42" ] && pass "POSTGRES_HOST_AUTH_METHOD=trust: connects without a password" || bad "trust"
        docker logs "$envname" 2>&1 | grep -q 'POSTGRES_HOST_AUTH_METHOD has been set to "trust"' && pass "the trust warning is printed" || bad "no trust warning"
    else
        bad "trust container did not come up: $(docker logs "$envname" 2>&1 | tail -n 5)"
    fi
    env_clean

    # /docker-entrypoint-initdb.d: *.sql run by the psql inside the executable, in name order; *.sh and compressed files are reported and skipped
    docker volume create "$vol-env" >/dev/null
    docker volume create "$vol-init" >/dev/null
    put() { docker run -i --rm -v "$vol-init:/i" --entrypoint "" "$builder" sh -c "cat > /i/$1 && chmod 644 /i/$1"; }
    put 10-first.sql <<'SQL'
CREATE TABLE boot (id int PRIMARY KEY, note text);
INSERT INTO boot VALUES (1, 'from first');
SQL
    put 20-second.sql <<'SQL'
CREATE FUNCTION boot_twice(i int) RETURNS int LANGUAGE plpgsql AS $$
BEGIN

  RETURN i * 2;
END
$$;
INSERT INTO boot SELECT 2, 'doubled ' || boot_twice(21);
\echo a psql meta command works
SQL
    printf 'echo this needs a shell
' | put 30-script.sh
    printf 'not really gzip
' | put 40-data.sql.gz
    docker run -d --name "$envname" --network "$net" -e POSTGRES_PASSWORD="$pw" -v "$vol-env:/var/lib/postgresql/data" -v "$vol-init:/docker-entrypoint-initdb.d:ro" "$img" >/dev/null
    if env_wait postgres "$pw" postgres; then
        [ "$(envq postgres "$pw" postgres "SELECT string_agg(note, ',' ORDER BY id) FROM boot")" = "from first,doubled 42" ] && pass "the .sql scripts of /docker-entrypoint-initdb.d ran, in order (a function body with blank lines, a psql meta command)" || bad "initdb.d: $(envq postgres "$pw" postgres 'SELECT * FROM boot')"
        docker logs "$envname" 2>&1 | grep -q "30-script.sh: ignoring (this image has no shell" && pass "a .sh script is reported and skipped" || bad "no message for the .sh script"
        docker logs "$envname" 2>&1 | grep -q "40-data.sql.gz: ignoring (compressed" && pass "a compressed script is reported and skipped" || bad "no message for the .gz script"
        docker logs "$envname" 2>&1 | grep -q "a psql meta command works" && pass "psql output reaches the container log" || bad "no psql output in the log"
    else
        bad "initdb.d container did not come up: $(docker logs "$envname" 2>&1 | tail -n 8)"
    fi
    env_clean
    docker volume rm -f "$vol-init" >/dev/null 2>&1 || true
    # a failing script stops the start, with a failure status
    docker volume create "$vol-env" >/dev/null
    docker volume create "$vol-init" >/dev/null
    docker run --rm -v "$vol-init:/i" --entrypoint "" "$builder" sh -c 'printf "SELECT * FROM table_that_does_not_exist;\n" > /i/10-bad.sql; chmod 644 /i/*'
    set +e
    out=$(docker run --rm --name "$envname" -e POSTGRES_PASSWORD="$pw" -v "$vol-env:/var/lib/postgresql/data" -v "$vol-init:/docker-entrypoint-initdb.d:ro" "$img" 2>&1); rc=$?
    set -e
    { [ "$rc" = 1 ] && echo "$out" | grep -q "10-bad.sql failed"; } && pass "a failing .sql script stops the container (exit 1)" || bad "bad script: rc=$rc $(echo "$out" | tail -n 4)"
    env_clean
    docker volume rm -f "$vol-init" >/dev/null 2>&1 || true

    # refusals, with the messages of the official image
    docker volume create "$vol-env" >/dev/null
    set +e
    out=$(docker run --rm --name "$envname" -v "$vol-env:/var/lib/postgresql/data" "$img" 2>&1); rc=$?
    set -e
    { [ "$rc" = 1 ] && echo "$out" | grep -q "superuser password is not specified"; } && pass "no password and no trust: refused with the official message" || bad "no password: rc=$rc $out"
    set +e
    out=$(docker run --rm --name "$envname" -e POSTGRES_PASSWORD=a -e POSTGRES_PASSWORD_FILE=/x -v "$vol-env:/var/lib/postgresql/data" "$img" 2>&1); rc=$?
    set -e
    { [ "$rc" = 1 ] && echo "$out" | grep -q "are exclusive"; } && pass "POSTGRES_PASSWORD together with POSTGRES_PASSWORD_FILE is refused" || bad "exclusive: rc=$rc $out"
    env_clean

    [ "$fail" = 0 ] && echo "native image test: PASS" || { echo "native image test: FAIL"; exit 1; }
    ;;
*)
    echo "native: unknown command $cmd" >&2; exit 2 ;;
esac
