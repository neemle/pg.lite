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
        builder-check capture-toolchain update-toolchain-lock

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

# Patch series (docs/patches.md). VERSION defaults to the baseline in sources.lock.json.
TARGETS ?= common,native

patches-verify:
	@node scripts/patches.js verify

patches-apply:
	@$(if $(VERSION),,$(error VERSION=<x.y> is required, e.g. ./dc make patches-apply VERSION=18.6))node scripts/patches.js apply --src cache/src/$(VERSION) --out build/$(VERSION)/src --targets $(TARGETS)

test-patches:
	@node tests/patches/run.js

# All repo self-tests that need no network.
selftest: check-repo test-repo test-locks test-fetch test-patches patches-verify validate-locks

# Offline negative tests for make fetch (tampered archive, unknown version, invalid lock).
test-fetch:
	@tests/fetch/test-fetch.sh
