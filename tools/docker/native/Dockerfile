# Native runtime image: one static executable and nothing else. No shell, no dynamic loader, no shared
# library, no package manager, no /etc/passwd. postgres carries initdb, the entrypoint logic and the
# share/ data files inside itself (patches/native/0006-embedded-image.patch).
# The build context is assembled by scripts/native-image.sh (rootfs/ holds /usr/local/pgsql/bin/postgres and an empty /tmp;
# pgdata/ is an empty directory).
FROM scratch

COPY rootfs/ /
# An empty, writable-by-the-server data directory (the volume mounts over it).
COPY --chown=70:70 pgdata/ /var/lib/postgresql/data/

USER 70:70
ENV PGDATA=/var/lib/postgresql/data
EXPOSE 5432
# Fast shutdown (SIGINT) instead of the smart shutdown SIGTERM would request.
STOPSIGNAL SIGINT
# --launcher: initialise PGDATA on the first start, then run the server; arguments after it go to postgres.
ENTRYPOINT ["/usr/local/pgsql/bin/postgres", "--launcher"]
