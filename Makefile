# compact.db - build scripts for minimal PostgreSQL (static musl Docker image + WASM).
#
# Every target of the project contract is declared here. A target whose owning
# backlog item has not landed fails loudly through scripts/not-implemented.sh
# instead of passing silently; the owning story fills it in.
#
# Run it as ./dc make <target>: dc starts the tools container and runs make in it.

# Nothing builds or runs on the host. Use: ./dc make <target>   (see docker/tools/Dockerfile).
ifeq ($(wildcard /.compactdb-tools /.compactdb-builder),)
$(error Not inside a project container. Run: ./dc make $(MAKECMDGOALS)   (builders: ./dcb musl|wasm make ...))
endif

SHELL := /bin/sh
NOT_IMPL := scripts/not-implemented.sh

.PHONY: help fetch native wasm verify-static test-native test-wasm \
        test-portability size-report verify release check-repo test-repo \
        validate-locks test-locks test-fetch selftest \
        patches-verify patches-apply test-patches \
        builder-check capture-toolchain update-toolchain-lock reference \
        feature-check feature-matrix test-feature release-index test-release-index \
        resolve resolve-check test-resolve probe probe-all test-probe \
        check-static test-check-static check-wasm test-check-wasm wasm-src wasm-build test-wasm-node \
        native-build native-src test-noshell

help:
	@echo "Targets: fetch native wasm verify-static test-native test-wasm"
	@echo "         test-portability size-report verify release"
	@echo "Repo hygiene: check-repo (no PostgreSQL source committed), test-repo"

# ./dc make fetch [VERSION=18.6]  - downloads only the release pinned in sources.lock.json.
fetch:
	@scripts/fetch.sh "$(VERSION)"

native:
	@$(NOT_IMPL) native CDB-3

wasm:
	@$(NOT_IMPL) wasm CDB-6

verify-static:
	@$(NOT_IMPL) verify-static CDB-3

test-native:
	@$(NOT_IMPL) test-native CDB-4

test-wasm:
	@$(NOT_IMPL) test-wasm CDB-7

test-portability:
	@$(NOT_IMPL) test-portability CDB-9

size-report:
	@$(NOT_IMPL) size-report CDB-10

# verify must fail while any mandatory check is unimplemented, FAIL or BLOCKED.
verify: check-repo
	@$(NOT_IMPL) verify CDB-11

release:
	@$(NOT_IMPL) release CDB-11

# Repo hygiene (implemented): the repository must never contain a PostgreSQL source tree.
check-repo:
	@scripts/check-no-pg-source.sh .

test-repo:
	@tests/repo/test-check-no-pg-source.sh

# Lock files (schemas in schemas/, validator in scripts/validate-locks.js).
validate-locks:
	@node scripts/validate-locks.js

test-locks:
	@node tests/lock/run.js

# Builder images (docs/builders.md). Run inside a builder: ./dcb musl make builder-check
builder-check:
	@scripts/check-builder.sh

capture-toolchain:
	@scripts/capture-toolchain.sh

update-toolchain-lock:
	@node scripts/update-toolchain-lock.js

# Apply the common+native patch series into build/native/<v>/src (tools container):
native-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/native/$(VERSION)/src --targets common,native

# Apply the common+wasm patch series into build/wasm/<v>/src (tools container):
wasm-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/wasm/$(VERSION)/src --targets common,wasm

# WebAssembly build of one release (docs/wasm.md): ./dcb wasm make wasm-build VERSION=18.6
wasm-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/build-wasm.sh $(VERSION)

# Run SQL in the built wasm server under node: ./dcb wasm make test-wasm-node VERSION=18.6
test-wasm-node:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))tests/wasm/test-wasm-node.sh $(VERSION)

# Static musl build of one release (docs/native.md): ./dcb musl make native-build VERSION=18.6
native-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/build-native.sh $(VERSION)

# No-shell spawn code test (needs the configured tree): ./dcb musl make test-noshell VERSION=18.6
test-noshell:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))tests/native/test-noshell.sh $(VERSION)

# Output checks (docs/checks.md). check-static needs readelf: ./dcb musl make check-static DIR=<path>
check-static:
	@$(if $(DIR),,$(error DIR=<path> is required))scripts/check-static.sh $(CHECK_OPTS) $(DIR)

test-check-static:
	@tests/checks/test-static.sh

check-wasm:
	@$(if $(DIR),,$(error DIR=<path> is required))node scripts/check-wasm.js $(CHECK_OPTS) $(DIR)

test-check-wasm:
	@node tests/checks/run.js

# Configure probing (docs/probe.md): ./dc make probe VERSION=18.6; probe-all needs network the first time.
probe:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/probe.js $(VERSION)

probe-all:
	@node scripts/probe.js --all

test-probe:
	@node tests/probe/run.js

# Version-range model (docs/ranges.md): ./dc make resolve VERSION=13.4 [RESOLVE_OPTS=--allow-missing-builder]
resolve:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/resolve.js $(VERSION) $(RESOLVE_OPTS)

resolve-check:
	@node scripts/resolve.js --check-all --allow-missing-builder

test-resolve:
	@node tests/resolve/run.js

# Release list: every final PostgreSQL release 9.0..latest -> sources.lock.json (needs network;
# ./dc enables it for this target). test-release-index is offline.
release-index:
	@node scripts/release-index.js

test-release-index:
	@node tests/release/run.js

# Feature profile (docs/feature-matrix.md is generated from feature-profile.json).
# feature-check needs the fetched tree (./dc make fetch); the others do not.
feature-check:
	@node scripts/feature-profile.js check $(if $(VERSION),--version $(VERSION))

feature-matrix:
	@node scripts/feature-profile.js matrix

test-feature:
	@node tests/feature/run.js

# Unmodified upstream reference build (docs/reference.md): ./dcb ref make reference VERSION=18.6
reference:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required, e.g. ./dcb ref make reference VERSION=18.6))scripts/build-reference.sh $(VERSION)

# Patch series (docs/patches.md). VERSION defaults to the baseline in sources.lock.json.
TARGETS ?= common,native

patches-verify:
	@node scripts/patches.js verify

patches-apply:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required, e.g. ./dc make patches-apply VERSION=18.6))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/$(VERSION)/src --targets $(TARGETS)

test-patches:
	@node tests/patches/run.js

# All repo self-tests that need no network.
selftest: check-repo test-repo test-locks test-fetch test-patches patches-verify validate-locks test-feature test-release-index test-resolve resolve-check test-probe test-check-wasm

# Offline negative tests for make fetch (tampered archive, unknown version, invalid lock).
test-fetch:
	@tests/fetch/test-fetch.sh
