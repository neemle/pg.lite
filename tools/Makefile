# compact.db - build scripts for minimal PostgreSQL (static musl Docker image + WASM).
#
# The build steps and checks of the project. ../builder.sh runs them in order; each can also be run alone.
#
# Run it as tools/dc make <target>: dc starts the tools container and runs make in it.

# Nothing builds or runs on the host. Use: tools/dc make <target>   (see docker/tools/Dockerfile).
ifeq ($(wildcard /.compactdb-tools /.compactdb-builder),)
$(error Not inside a project container. Run: tools/dc make $(MAKECMDGOALS)   (builders: tools/dcb musl|wasm|web make ...))
endif

SHELL := /bin/sh

.PHONY: help fetch test-wasm check-repo test-repo \
        validate-locks test-locks test-fetch selftest \
        patches-verify patches-apply test-patches \
        builder-check capture-toolchain update-toolchain-lock reference \
        feature-check feature-matrix test-feature release-index test-release-index \
        resolve resolve-check test-resolve probe probe-all test-probe \
        check-static test-check-static check-wasm test-check-wasm wasm-src wasm-build test-wasm-node web-demo package-wasm \
        native-build native-src test-noshell test-release-plan check-releases

help:
	@echo "Build an image or the WebAssembly module with ../builder.sh; its steps are these targets:"
	@echo "  fetch native-src native-build wasm-src wasm-build package-wasm test-wasm test-wasm-node"
	@echo "Checks: selftest (no network), check-repo (no PostgreSQL source committed), patches-verify"

# tools/dc make fetch [VERSION=18.6]  - downloads only the release pinned in sources.lock.json.
fetch:
	@scripts/fetch.sh "$(VERSION)"

# Browser tests of the built module (Chromium in the web builder): tools/dcb web make test-wasm VERSION=18.6
test-wasm:
	@scripts/web-test.sh

# Repo hygiene: the repository must never contain a PostgreSQL source tree.
check-repo:
	@scripts/check-no-pg-source.sh .

test-repo:
	@tests/repo/test-check-no-pg-source.sh

# Lock files (schemas in schemas/, validator in scripts/validate-locks.js).
validate-locks:
	@node scripts/validate-locks.js

test-locks:
	@node tests/lock/run.js

# Builder images (docs/builders.md). Run inside a builder: tools/dcb musl make builder-check
builder-check:
	@scripts/check-builder.sh

capture-toolchain:
	@scripts/capture-toolchain.sh

update-toolchain-lock:
	@node scripts/update-toolchain-lock.js

# Apply the common+native patches of the release into build/native/<v>/src (tools container):
native-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/native/$(VERSION)/src --target native --version $(VERSION)
	@node scripts/resolve.js $(VERSION) --allow-missing-builder --write-build-args build/native/$(VERSION) --target native

# Apply the common+wasm patches of the release into build/wasm/<v>/src (tools container):
wasm-src:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/wasm/$(VERSION)/src --target wasm --version $(VERSION)
	@node scripts/resolve.js $(VERSION) --allow-missing-builder --write-build-args build/wasm/$(VERSION) --target wasm

# WebAssembly build of one release (docs/wasm.md): tools/dcb wasm make wasm-build VERSION=18.6
wasm-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/build-wasm.sh $(VERSION)

# Angular + TypeORM demo on the browser module (docs/wasm.md): tools/dcb web make web-demo VERSION=18.6
web-demo:
	@scripts/web-demo.sh

# Release archive of the browser module (scripts/package-wasm.sh): tools/dc make package-wasm VERSION=18.6
package-wasm:
	@scripts/package-wasm.sh

# Run SQL in the built wasm server under node: tools/dcb wasm make test-wasm-node VERSION=18.6
test-wasm-node:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))tests/wasm/test-wasm-node.sh $(VERSION)

# Static musl build of one release (docs/native.md): tools/dcb musl make native-build VERSION=18.6
native-build:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))scripts/build-native.sh $(VERSION)

# No-shell spawn code test (needs the configured tree): tools/dcb musl make test-noshell VERSION=18.6
test-noshell:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))tests/native/test-noshell.sh $(VERSION)

# Output checks (docs/checks.md). check-static needs readelf: tools/dcb musl make check-static DIR=<path>
check-static:
	@$(if $(DIR),,$(error DIR=<path> is required))scripts/check-static.sh $(CHECK_OPTS) $(DIR)

test-check-static:
	@tests/checks/test-static.sh

check-wasm:
	@$(if $(DIR),,$(error DIR=<path> is required))node scripts/check-wasm.js $(CHECK_OPTS) $(DIR)

test-check-wasm:
	@node tests/checks/run.js

# Configure probing (docs/probe.md): tools/dc make probe VERSION=18.6; probe-all needs network the first time.
probe:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/probe.js $(VERSION)

probe-all:
	@node scripts/probe.js --all

test-probe:
	@node tests/probe/run.js

# Version-range model (docs/ranges.md): tools/dc make resolve VERSION=13.4 [RESOLVE_OPTS=--allow-missing-builder]
resolve:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required))node scripts/resolve.js $(VERSION) $(RESOLVE_OPTS)

resolve-check:
	@node scripts/resolve.js --check-all --allow-missing-builder

test-resolve:
	@node tests/resolve/run.js

# Release list: every final PostgreSQL release 9.0..latest -> sources.lock.json (needs network;
# tools/dc enables it for this target). test-release-index is offline.
release-index:
	@node scripts/release-index.js

# Do the patch folders apply to every release? (docs/patches.md) Needs network: tools/dc enables it for
# 'check-releases'. Example: tools/dc make check-releases ARGS="--range pg12 --recheck"
check-releases:
	@node scripts/check-releases.js $(if $(ARGS),$(ARGS),--all)

test-release-index:
	@node tests/release/run.js

# Feature profile (docs/feature-matrix.md is generated from feature-profile.json).
# feature-check needs the fetched tree (tools/dc make fetch); the others do not.
feature-check:
	@node scripts/feature-profile.js check $(if $(VERSION),--version $(VERSION))

feature-matrix:
	@node scripts/feature-profile.js matrix

test-feature:
	@node tests/feature/run.js

# Unmodified upstream reference build (docs/reference.md): tools/dcb ref make reference VERSION=18.6
reference:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required, e.g. tools/dcb ref make reference VERSION=18.6))scripts/build-reference.sh $(VERSION)

# Patch folders (docs/patches.md). VERSION defaults to the baseline in sources.lock.json.
TARGETS ?= common,native

patches-verify:
	@node scripts/patches.js verify

patches-apply:
	@$(if $(VERSION),,$(error VERSION=<x.y> TARGET=native|wasm are required, e.g. tools/dc make patches-apply VERSION=18.6 TARGET=native))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/$(TARGET)/$(VERSION)/src --target $(TARGET) --version $(VERSION)

test-patches:
	@node tests/patches/run.js

# All repo self-tests that need no network.
selftest: check-repo test-repo test-locks test-fetch test-patches patches-verify validate-locks test-feature test-release-index test-resolve resolve-check test-release-plan test-probe test-check-wasm

# The tag is the PostgreSQL version (scripts/release-plan.js, .github/workflows/release.yml).
test-release-plan:
	@node tests/release-plan/run.js

# Offline negative tests for make fetch (tampered archive, unknown version, invalid lock).
test-fetch:
	@tests/fetch/test-fetch.sh
