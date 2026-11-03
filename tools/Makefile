# pg.lite - build scripts for minimal PostgreSQL (static musl Docker image + WASM).
#
# The build steps and checks of the project. ../builder.sh runs them in order; each can also be run alone.
#
# Run it as tools/dc make <target>: dc starts the tools container and runs make in it.

# Nothing builds or runs on the host. Use: tools/dc make <target>   (see docker/tools/Dockerfile).
ifeq ($(wildcard /.compactdb-tools /.compactdb-builder),)
$(error Not inside a project container. Run: tools/dc make $(MAKECMDGOALS)   (builders: tools/dcb musl|wasm|web make ...))
endif

SHELL := /bin/sh

.PHONY: help fetch test-wasm check-repo \
        selftest \
        patches-verify \
        builder-check reference \
        feature-check release-index \
        check-static test-check-static check-wasm test-check-wasm wasm-src wasm-build test-wasm-node web-demo package-wasm \
        native-build native-src test-noshell

help:
	@echo "Build an image or the WebAssembly module with ../builder.sh; its steps are these targets:"
	@echo "  fetch native-src native-build wasm-src wasm-build package-wasm test-wasm test-wasm-node"
	@echo "Checks: selftest (no network), check-repo (no PostgreSQL source committed), patches-verify"

# tools/dc make fetch [VERSION=18.6]  - downloads only the release pinned in releases.txt.
fetch:
	@scripts/fetch.sh "$(VERSION)"

# Browser tests of the built module (Chromium in the web builder): tools/dcb web make test-wasm VERSION=18.6
test-wasm:
	@wasm/web-test.sh

# Repo hygiene: the repository must never contain a PostgreSQL source tree.
check-repo:
	@scripts/check-no-pg-source.sh .

# Builder images . Run inside a builder: tools/dcb musl make builder-check
builder-check:
	@scripts/check-builder.sh

# Apply the common+native patches of the release into build/native/<v>/src (tools container):
native-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/patches.sh apply cache/src/$(VERSION) build/native/$(VERSION)/src native

# Apply the common+wasm patches of the release into build/wasm/<v>/src (tools container):
wasm-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/patches.sh apply cache/src/$(VERSION) build/wasm/$(VERSION)/src wasm

# WebAssembly build of one release : tools/dcb wasm make wasm-build VERSION=18.6
wasm-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))wasm/build.sh $(VERSION)

# Angular + TypeORM demo on the browser module : tools/dcb web make web-demo VERSION=18.6
web-demo:
	@wasm/web-demo.sh

# Release archive of the browser module (wasm/package.sh): tools/dc make package-wasm VERSION=18.6
package-wasm:
	@wasm/package.sh

# Run SQL in the built wasm server under node: tools/dcb wasm make test-wasm-node VERSION=18.6
test-wasm-node:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))wasm/tests/test-wasm-node.sh $(VERSION)

# Static musl build of one release : tools/dcb musl make native-build VERSION=18.6
native-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))image/build.sh $(VERSION)

# No-shell spawn code test (needs the configured tree): tools/dcb musl make test-noshell VERSION=18.6
test-noshell:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))image/tests/test-noshell.sh $(VERSION)

# Output checks . check-static needs readelf: tools/dcb musl make check-static DIR=<path>
check-static:
	@$(if $(DIR),,$(error DIR=<path> is required))image/check-static.sh $(CHECK_OPTS) $(DIR)

test-check-static:
	@image/tests/test-static.sh

check-wasm:
	@$(if $(DIR),,$(error DIR=<path> is required))node wasm/check-wasm.cjs $(CHECK_OPTS) $(DIR)

test-check-wasm:
	@node wasm/tests/check-wasm.test.cjs

# Unmodified upstream reference build : tools/dcb ref make reference VERSION=18.6
reference:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required, e.g. tools/dcb ref make reference VERSION=18.6))image/build-reference.sh $(VERSION)

# The patches (scripts/patches.sh): verify their headers, apply them with GNU patch.
patches-verify:
	@scripts/patches.sh verify

# All repo self-tests that need no network.
selftest: check-repo patches-verify test-check-wasm

