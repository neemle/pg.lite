# Runtime image for the UNMODIFIED reference PostgreSQL (dynamic glibc, default configure).
# Context is assembled by image/reference.sh image: this Dockerfile, entrypoint.sh and
# install.tar (the `make install` tree produced by tools/dcb ref make reference).
# Same base as docker/builders/ref so the shared libraries match what it was built against.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu72 libreadline8 zlib1g \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 70 --home-dir /var/lib/postgresql --create-home postgres \
 && mkdir -p /var/lib/postgresql/data && chown postgres:postgres /var/lib/postgresql/data

ADD install.tar /
RUN echo /usr/local/pgsql/lib > /etc/ld.so.conf.d/pgsql.conf && ldconfig
COPY entrypoint.sh /entrypoint.sh

ENV PATH=/usr/local/pgsql/bin:$PATH PGDATA=/var/lib/postgresql/data
USER postgres
EXPOSE 5432
ENTRYPOINT ["/entrypoint.sh"]
