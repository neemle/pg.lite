# Native runtime image: one static executable and nothing else. No shell, no dynamic loader, no shared
# library, no package manager, no /etc/passwd. postgres carries initdb, psql, the entrypoint logic and the
# share/ data files inside itself (patch 0900-single-binary).
# The build context is assembled by image/image.sh (rootfs/ holds /usr/local/pgsql/bin/postgres and an empty /tmp;
# pgdata/ is an empty directory). image.sh passes the build arguments below; nothing in this file names a release.
FROM scratch

ARG PG_VERSION
ARG PG_MAJOR
# the user and group the server runs as (and that own the data directory)
ARG PG_UID=70
ARG PG_GID=70
ARG PGDATA_DIR=/var/lib/postgresql/data
ARG REVISION=unknown
ARG CREATED=unknown
ARG PACKED=no
ARG ARCH=amd64

LABEL org.opencontainers.image.title="pg.lite" \
      org.opencontainers.image.description="PostgreSQL ${PG_VERSION} as one static executable in a FROM scratch image" \
      org.opencontainers.image.version="${PG_VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.source="https://github.com/neemle/pg.lite" \
      org.opencontainers.image.url="https://github.com/neemle/pg.lite" \
      org.opencontainers.image.documentation="https://github.com/neemle/pg.lite#configuration-of-the-image" \
      org.opencontainers.image.licenses="PostgreSQL" \
      io.github.neemle.pglite.postgres-major="${PG_MAJOR}" \
      io.github.neemle.pglite.platform="linux/${ARCH}, static, musl" \
      io.github.neemle.pglite.packed="${PACKED}"

COPY rootfs/ /
# An empty data directory owned by the server's user; a volume mounted over it keeps the ownership.
COPY --chown=${PG_UID}:${PG_GID} pgdata/ ${PGDATA_DIR}/

# The release and the data directory, as in the official image. The POSTGRES_* variables of the official image
# (POSTGRES_PASSWORD, POSTGRES_USER, POSTGRES_DB, POSTGRES_INITDB_ARGS, POSTGRES_INITDB_WALDIR,
# POSTGRES_HOST_AUTH_METHOD and their _FILE forms) are read by the launcher when the container starts; they have no default here.
ENV PG_MAJOR=${PG_MAJOR} \
    PG_VERSION=${PG_VERSION} \
    PGDATA=${PGDATA_DIR} \
    LANG=C.UTF-8

VOLUME ${PGDATA_DIR}
USER ${PG_UID}:${PG_GID}
EXPOSE 5432
# Fast shutdown (SIGINT) instead of the smart shutdown SIGTERM would request.
STOPSIGNAL SIGINT
# --launcher: initialise PGDATA on the first start, then run the server; arguments after it go to postgres.
ENTRYPOINT ["/usr/local/pgsql/bin/postgres", "--launcher"]
