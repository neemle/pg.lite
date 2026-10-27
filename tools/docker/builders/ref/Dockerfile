# Reference builder: a normal glibc/dynamic toolchain that builds UNMODIFIED upstream PostgreSQL
# with its default configuration. Its output is the behavior and size baseline the static musl
# and WASM builds are compared against; it must never get patches or size flags.
# Base pinned by digest (tag informational). Use through tools/dcb ref <command>.
#
# NOTE: apt packages are not version-pinned; scripts/build-reference.sh records the installed
# versions in reports/reference-size.json.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential bison flex perl pkg-config \
        zlib1g-dev libreadline-dev libicu-dev \
        patch tar bzip2 xz-utils git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=ref
WORKDIR /w
