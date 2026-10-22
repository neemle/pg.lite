# Tools image: everything the repo's make targets, scripts and tests need, so the host
# only ever runs docker. Use it through ./dc (see docs/build.md).
#
# Base: node:24-bookworm-slim, pinned by digest (the tag is informational).
# NOTE: apt packages below are not version-pinned yet; toolchain pinning for the build
# images is owned by CDB-17 and should extend to this image.
FROM node:24-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        make git curl ca-certificates bzip2 xz-utils patch \
 && rm -rf /var/lib/apt/lists/* \
 # The repo is a bind mount owned by the host user; let git work in it as any user.
 && git config --system --add safe.directory '*' \
 # Marker the Makefile checks so make refuses to run outside this image.
 && touch /.compactdb-tools

WORKDIR /w
