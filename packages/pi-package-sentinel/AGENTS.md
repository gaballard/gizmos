# Agent Guidelines for package-sentinel

This project uses `build-graph` - a CLI tool that builds a SQLite knowledge graph of the TypeScript codebase. Use it. It is much faster and more accurate than grepping for structural questions.

## Workflow Rules

### 1. Build the graph on first contact

When you start working on this project, check if `graph.db` exists and is fresh (modified within the last 24 hours). If not, build it:

```bash
# If graph.db is missing or stale
build-graph scan . ./graph.db

# If graph.db exists and you only edited a few files
build-graph update ./graph.db src/file1.ts src/file2.ts
```

### 2. Query before you grep

For structural questions, query the graph first instead of grepping:

| Instead of...                    | Query the graph                                      |
| -------------------------------- | ---------------------------------------------------- |
| `grep -r "function foo"`         | `build-graph search ./graph.db foo`                  |
| "What uses this function?"       | `build-graph callers ./graph.db foo`                 |
| "What does this module import?"  | `build-graph deps ./graph.db module.ts --downstream` |
| "How are these files connected?" | `build-graph path ./graph.db A.ts B.ts`              |

### 3. Inspect before editing exported symbols

Before modifying any **exported** function, class, interface, or schema, check its relationships:

```bash
build-graph inspect ./graph.db SymbolName
build-graph callers ./graph.db SymbolName
build-graph deps ./graph.db SymbolName
```

### 4. Update the graph after structural edits

After a batch of edits that change signatures, exports/imports, schemas, or component hierarchies:

```bash
build-graph update ./graph.db src/auth.ts src/schema.ts
```

> **When NOT to update:** Purely internal changes inside a single function body (no signature changes, no new imports/exports, no JSX changes).

## Schema Reference

```sql
-- Key tables
nodes(id, type, name, file_path, line_start, line_end, summary, tags, package_id)
edges(id, source, target, type, direction, weight)
meta(key, value)   -- includes project_root
```

**Node types:** `file`, `function`, `class`, `interface`, `type_alias`, `schema`, `field`

**Edge types:** `contains`, `imports`, `extends`, `implements`, `calls`, `depends_on`, `has_field`, `references`, `renders`, `uses_hook`, `queries`, `mutates`

---

# Engineering notes (Pi adapter)

The build-graph workflow above still applies. The sections below are the adapter's engineering reference.

## Scope (Pi surface)

**Does (Pi surface):**

- Blocks `tool_call` events that target a `flagged` or **too-new** (or, under fail-closed, OSV-unchecked) version, recommending the most recent confirmed-safe alternative.
- Snapshots the manifest before each tool (`tool_execution_start`), then re-snapshots, leak-flags, and **pins** safe range-added deps at `tool_execution_end` and `turn_end`.
- Registers the `assert_installable` tool the agent should call _before_ writing a dependency.
- Extracts install targets from tool args _and_ from shell command text (`add`/`install`/`require`/`save`/`fetch`).

**Does not:**

- Perform any vetting itself - all of it is delegated to `package-sentinel-core`.
- Monitor more than one manifest in the gate - the core's `findManifest` watches the **first** supported manifest **at** `cwd` (it checks only the working directory itself for the five known manifest names); the `/audit` command separately scans every supported manifest under cwd + subfolders via `auditAllManifests`.
- Enforce beyond NPM/PyPI/crates.io.

## Consumers

A Pi runtime loads this as an extension (`pi.extensions: ["./src/index.ts"]` in package.json). It uses the Pi `ExtensionAPI` - `pi.on("tool_call" | "tool_execution_start" | "tool_execution_end" | "turn_end")`, `pi.registerTool`, `ctx.cwd`, `ctx.hasUI`/`ctx.ui.notify` - and the vetting core's `auditAllManifests`, `createVetter`, `detectLeaks`, `extractTargets`, `isBlocked`, `isUnconfirmedPass`, `pinManifestChanges`, `snapshotManifests`.

## Wiring detail

- **Firing Point 1 (gate):** on `tool_call`, `targetsFromTool` gathers specs from the tool's `input` - `extractTargets` keys (`packages`, `dependencies`, `deps`, `targets`, `add`, or `package`+`version`) _plus_ a `command` string containing `add`/`install`/`require`/`save`/`fetch` (parsed for `name@version` tokens). Any blocked target returns `{ block: true, reason }` with a safe alternative from `recommendSafeVersion`, or "no safe version known". Under fail-open, an unconfirmed (not vetted) pass raises `ctx.ui.notify(..., "warning")` so it is never silent.
- **Firing Point 2 (validation + pin):** `pinAndClose` snapshots before→after, `detectLeaks` (flags `flagged` leaks always, plus `osvChecked:false` leaks under the fail-closed toggle), and `pinManifestChanges` rewrites range-added deps to exact safe versions (writes the manifest back only when content changed). Runs on `tool_execution_end` and `turn_end`; leaks are raised via `ctx.ui.notify(..., "error")`.
- **`assert_installable` tool:** vets each spec (params `packages[]`, TypeBox schema), appending `- try <alt> (<verdict>)` or "no safe version known" when blocked, or "no supported manifest in cwd; not vetted" / "invalid spec" / "no verdict" where applicable.
- **`audit` command (`/audit`):** vets EVERY dependency in EVERY supported manifest under cwd + subfolders (core `auditAllManifests`), not just additions. Exact specs are vetted directly; a range resolves to the newest matching version first. `--exclude <dirs>` skips folders; `--json` prints structured output; the report marks which entries are blocked (respecting the fail-open/fail-closed toggle).

## Runtime parity: Pi ↔ Claude Code

Same vetting core, two surfaces. The Claude Code port lives in [`../claude-package-sentinel`](../claude-package-sentinel/); its AGENTS.md carries the same table from the other direction.

> NOTE: Pi refers to the Pi agent harness ([https://pi.dev/](https://pi.dev/)), **not** Raspberry Pi.

| Pi adapter (this package)              | Claude Code adapter (claude-package-sentinel)                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tool_call` gate                       | `PreToolUse` hook on `Bash\|Write\|Edit\|NotebookEdit` → `permissionDecision: "deny"`        |
| `tool_execution_start` snapshot        | `PreToolUse` - persists a manifest snapshot keyed by `session_id`                            |
| `tool_execution_end` leak detect + pin | `PostToolUse` - snapshot diff, flag leaks (`additionalContext`), pin range deps (write-back) |
| `turn_end` safety net                  | `Stop` hook - last leak scan + pin + unsupported-manifest note                               |
| `assert_installable` tool              | `package-sentinel` CLI (`assert` / `vet`) + `/package-sentinel:assert-installable` command   |
| `/audit` command                       | `package-sentinel audit [--json]` - full-manifest scan, non-zero exit if anything is blocked |

## Invariants

- **Fail-open by default:** `isBlocked` blocks `flagged` and too-new unconditionally; an OSV-unconfirmed version passes only with `ctx.ui.notify(..., "warning")`. `PACKAGE_SENTINEL_FAIL_CLOSED=1` (any truthy value) flips to deny-on-unconfirmed.
- **Stateless per session** apart from the lazily-created `Vetter` and the pre-tool snapshot buffer.
- **Manifest write-back only on real change:** the pinned content is written only when it differs from what was snapped after the tool.
- The extension never vets itself - every verdict, threshold (`TOO_NEW_DAYS`, `STALE_DAYS`), and registry endpoint comes from `package-sentinel-core` (see its AGENTS.md for the full module tour).

## Testing & validation

```bash
npm run check                             # strict tsc against the Pi API + typebox (package script)
npm test                                 # this package's suite (node --test): 85 tests - 81 pass, 4 skipped (live e2e, network-gated)
cd ../package-sentinel-core && npm test  # core unit suite - 76 tests
scripts/e2e.sh                           # headless regression backstop vs live OSV + npm registry (network; no LLM)
```

`scripts/e2e.sh` drives the real extension wiring (tool_call gate + tool_execution_end post-write validation) against live OSV + npm. It runs `RUN_LIVE_TESTS=1 CI=true npm test -- test/e2e.live.test.ts` and is skipped by default so the offline suite stays green.

Manual live agent-turn walkthrough (AC-3 - the live turn needs a provider Pi can actually select, so it is invoked by hand, not by the script):

```bash
export PACKAGE_SENTINEL_PROVIDER="ollama-cloud"      # defaults baked into e2e.sh
export PACKAGE_SENTINEL_MODEL="deepseek-v4-flash:0731-cloud"
pi -e ./src/index.ts --provider "$PACKAGE_SENTINEL_PROVIDER" --model "$PACKAGE_SENTINEL_MODEL" \
  --mode json -a -p "npm add lodash@4.17.19"
```

## Files

- `src/index.ts` - extension entry: the `default` export (hook + tool + command wiring) and the `targetsFromTool` helper.
- `test/` - adapter wiring tests plus mirrors of the core unit suites (`decide`, `detect`, `enforce`, `orchestrate`, `osv`, `pin`, `postwrite`, `registry`) and `e2e.live.test.ts` (live, skipped by default). `expect.ts` is the shared test helper.
- `scripts/e2e.sh` - launcher for the live regression backstop above.
- `AGENTS.md` - this file: build-graph workflow + engineering notes.

## Vetting-core API pointer

`package-sentinel-core` is the authoritative documentation for every module this extension drives (`contracts`, `detect`, `registry`, `osv`, `decide`, `enforce`, `postwrite`, `pin`, `orchestrate`) - full module tour in its AGENTS.md.
