# compact.db - build scripts for minimal PostgreSQL (static musl Docker image + WASM).
#
# Every target of the project contract is declared here. A target whose owning
# backlog item has not landed fails loudly through scripts/not-implemented.sh
# instead of passing silently; the owning story fills it in.
#
# Run with GNU make (Linux, WSL, or `docker run --rm -v "$PWD:/w" -w /w <image> make ...`).

SHELL := /bin/sh
NOT_IMPL := scripts/not-implemented.sh

.PHONY: help fetch native wasm verify-static test-native test-wasm \
        test-portability size-report verify release check-repo test-repo \
        validate-locks test-locks test-fetch

help:
	@echo "Targets: fetch native wasm verify-static test-native test-wasm"
	@echo "         test-portability size-report verify release"
	@echo "Repo hygiene: check-repo (no PostgreSQL source committed), test-repo"

# make fetch [VERSION=18.6]  - needs docker; downloads only the release pinned in sources.lock.json.
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

# Lock files (schemas in schemas/, validator in scripts/validate-locks.js; needs node or docker).
validate-locks:
	@scripts/run-node.sh scripts/validate-locks.js

test-locks:
	@scripts/run-node.sh tests/lock/run.js

# Offline negative tests for make fetch (tampered archive, unknown version, invalid lock).
test-fetch:
	@tests/fetch/test-fetch.sh
