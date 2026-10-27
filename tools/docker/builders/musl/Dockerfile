# Native builder: fully static x86_64 binaries against musl (Alpine is musl-native, so gcc and
# the libc headers/archives all come from the same musl). Used for the 18.x baseline.
# Base pinned by digest (tag is informational); recorded in toolchain.lock.json by
# scripts/update-toolchain-lock.js. Use through tools/dcb musl <command>.
#
# NOTE: apk packages come from the Alpine 3.24 repositories as of build time; the exact
# versions that were built are captured into toolchain.lock.json by scripts/capture-toolchain.sh.
FROM alpine:3.24.3@sha256:b3413572228e34bd1c9245f5565e6cd127005655e8a7899aef33d8e83255c9e6

# The optional build secret "corpca" (tools/dc passes .local/corp-ca.pem when it exists) is the root certificate of a
# TLS-inspecting corporate proxy; it is trusted for this one step and is not stored in the image.
RUN --mount=type=secret,id=corpca,required=false \
    if [ -s /run/secrets/corpca ]; then cat /run/secrets/corpca >> /etc/ssl/certs/ca-certificates.crt; fi \
 && apk add --no-cache \
        build-base bison flex perl linux-headers pkgconf \
        zlib-dev zlib-static \
        patch tar bzip2 xz git curl ca-certificates \
 # Marker the Makefile checks so make refuses to run outside a project container.
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=musl
WORKDIR /w
