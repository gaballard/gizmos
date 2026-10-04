#!/usr/bin/env bash

# Copyright 2026 Geoff Ballard
# SPDX-License-Identifier: Apache-2.0

# Headless regression backstop for the Claude Code Package Sentinel plugin.
#
# Drives the REAL hook boundary (a spawned hooks-handlers/handler.ts process
# speaking stdin/stdout JSON, as Claude Code does) against live OSV + npm
# registry. Network required; no LLM. Gated by the test file itself
# (skipped unless RUN_LIVE_TESTS=1) so the offline suite stays green.
#
# Divergence from the pi adapter's scripts/e2e.sh: pi's harness stubs the
# ExtensionAPI and drives handlers in-process (plus an optional live agent
# turn); Claude's handler is a process, so this suite exercises the actual
# stdin/stdout hook convention. Package Sentinel never calls an LLM, so no
# model env vars are needed here.

set -euo pipefail
cd "$(dirname "$0")/.."
RUN_LIVE_TESTS=1 CI=true node --test test/e2e.live.test.ts