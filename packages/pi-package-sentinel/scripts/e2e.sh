#!/usr/bin/env bash

# Copyright 2026 Geoff Ballard
# SPDX-License-Identifier: Apache-2.0

# Headless regression backstop for Package Sentinel.
#
# Drives the REAL extension wiring (tool_call gate + tool_execution_end
# post-write validation) against live OSV + npm registry. Network required;
# no LLM needed. Skipped-by-default in CI (RUN_LIVE_TESTS unset) so the suite
# stays green offline.
#
# MODEL SELECTION: Package Sentinel itself is deterministic and never calls an
# LLM, so it has no model config. The model that RUNS under it is pi's agent
# model, pinned explicitly for a real AC-3 walkthrough via these env vars:
#   PACKAGE_SENTINEL_PROVIDER  (default: ollama-cloud)
#   PACKAGE_SENTINEL_MODEL     (default: deepseek-v4-flash:0731-cloud)
# The live AC-3 agent turn is not executed here (needs a provider pi can
# actually select); invoke it manually with:
#   pi -e ./src/index.ts --provider "$PACKAGE_SENTINEL_PROVIDER" --model "$PACKAGE_SENTINEL_MODEL" --mode json -a -p "npm add lodash@4.17.19"

set -euo pipefail
cd "$(dirname "$0")/.."
export PACKAGE_SENTINEL_PROVIDER="${PACKAGE_SENTINEL_PROVIDER:-ollama-cloud}"
export PACKAGE_SENTINEL_MODEL="${PACKAGE_SENTINEL_MODEL:-deepseek-v4-flash:0731-cloud}"
RUN_LIVE_TESTS=1 CI=true npm test -- test/e2e.live.test.ts
