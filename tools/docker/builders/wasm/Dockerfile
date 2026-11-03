# WASM builder: official Emscripten SDK image (emcc, clang, wasm-ld, Binaryen, node).
# Base pinned by digest (the tag is informational). Use through tools/dcb wasm <command>.
#
# NOTE: apt packages added below are not version-pinned.
FROM emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a

RUN apt-get update \
 && apt-get install -y --no-install-recommends make bison flex perl patch bzip2 xz-utils git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Marker the Makefile checks so make refuses to run outside a project container.
 && touch /.compactdb-builder

ENV COMPACTDB_BUILDER=wasm
WORKDIR /w
