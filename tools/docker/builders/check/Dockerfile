# Check builder: what scripts/check-releases.js needs to prove that every release of every range takes its patch
# series and that the files the patches touch still compile (node for the tooling, a C compiler, bison and flex for
# configure and the generated headers, patch, tar and bzip2 for the sources). It builds nothing that ships.
# Use through tools/dcb check <command>, with DC_NET=1 for the downloads:
#   DC_NET=1 FETCH_HTTP_FALLBACK=1 tools/dcb check node scripts/check-releases.js --all
# Base: the same pinned Alpine as the musl builder.
FROM alpine:3.24.3@sha256:b3413572228e34bd1c9245f5565e6cd127005655e8a7899aef33d8e83255c9e6

RUN --mount=type=secret,id=corpca,required=false \
    if [ -s /run/secrets/corpca ]; then cat /run/secrets/corpca >> /etc/ssl/certs/ca-certificates.crt; fi \
 && apk add --no-cache \
        build-base bison flex perl linux-headers pkgconf \
        nodejs patch tar bzip2 xz git curl ca-certificates \
 && git config --system --add safe.directory '*' \
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=check
WORKDIR /w
