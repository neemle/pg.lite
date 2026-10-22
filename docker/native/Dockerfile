# Native runtime image: nothing but static executables, the data files initdb needs, and the
# minimal user records. No shell, no dynamic loader, no shared libraries, no package manager.
# The build context is assembled by scripts/native-image.sh (rootfs/ and an empty pgdata/).
FROM scratch

COPY rootfs/ /
# An empty, writable-by-the-server data directory (the volume mounts over it).
COPY --chown=70:70 pgdata/ /var/lib/postgresql/data/

USER 70:70
ENV PGDATA=/var/lib/postgresql/data
EXPOSE 5432
# Fast shutdown (SIGINT) instead of the smart shutdown SIGTERM would request.
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/pgsql/bin/pg-launcher"]
