#!/bin/sh
# Reference server entrypoint: cold init on an empty PGDATA, then exec the server.
# UTF-8, UTC, builtin C.UTF-8 locale provider (the profile shared with the other targets),
# SCRAM-SHA-256 for network clients. An existing cluster is reused; a non-empty directory that
# is not a cluster is refused, never cleaned.
set -eu
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${PGDATA:=/var/lib/postgresql/data}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    if [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
        echo "entrypoint: $PGDATA is not empty and is not a PostgreSQL cluster; refusing to touch it" >&2
        exit 1
    fi
    pwfile=$(mktemp)
    printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
    initdb -D "$PGDATA" --username=postgres --pwfile="$pwfile" \
        --encoding=UTF8 --locale=C.UTF-8 --locale-provider=builtin --builtin-locale=C.UTF-8 \
        --auth-local=trust --auth-host=scram-sha-256
    rm -f "$pwfile"
    {
        echo "listen_addresses = '*'"
        echo "timezone = 'UTC'"
        echo "log_timezone = 'UTC'"
    } >> "$PGDATA/postgresql.conf"
    echo "host all all all scram-sha-256" >> "$PGDATA/pg_hba.conf"
fi
exec postgres -D "$PGDATA"
