# AGENTS.md - claude-package-sentinel

Engineering reference for the Claude Code Package Sentinel plugin. The end-user story (install, verdicts, policies) lives in README.md - keep the two consistent when you edit either. The full vetting-core internals live in `../package-sentinel-core/AGENTS.md`; this file covers only the Claude Code adapter layer.

## How it works

Three Claude Code hook events funnel into one handler:

```text
PreToolUse (matcher: Bash, Write, Edit, NotebookEdit)  -> hooks-handlers/handler.ts
PostToolUse (all tools)                                -> hooks-handlers/handler.ts
Stop (all tools)                                       -> hooks-handlers/handler.ts
```

`hooks/hooks.json` registers the same `node "${CLAUDE_PLUGIN_ROOT}"/hooks-handlers/handler.ts` command for all three events. `handler.ts` reads the event JSON from stdin (Claude Code hook convention), dispatches by `hook_event_name`, and writes the hook result JSON to stdout (`jsonOut`, always exit 0 - verdicts travel in the payload, not the exit code).

**PreToolUse (Firing Point 1 - the gate):**

1. `snapshotManifests(cwd)` and `saveSnapshot(sessionId, before)` - the persisted "before" state used by PostToolUse/Stop.
2. `extractInstallTargets(input, beforeByPath)` gathers specs: core `extractTargets` keys (`packages`/`dependencies`/`deps`/`targets`/`add`, or `package`+`version`), a `command`/`command_text` string containing `add`/`install`/`require`/`save` (parsed for `name@version` tokens), and - for manifest `Write`/`Edit` events - deps **added by the edit** (`diffManifests` against the pre-edit content; only exact versions become gate targets via `depVersion`; ranges go through the post-write pin path instead). Delta-aware: existing deps are never re-vetted.
3. Each target runs `vet`; a blocked verdict emits `permissionDecision: "deny"` with `[Package Sentinel] Refuse <name>@<version>: <reason> - try <alt> (<verdict>)` (or "no safe version known"). An unconfirmed pass emits `permissionDecision: "allow"` whose reason is the loud `[Package Sentinel] not vetted: ...` notice (fail-open, never silent). No targets → empty `{}`.

**PostToolUse / Stop (Firing Point 2 - validation + pin):** `runPostWrite(vetter, cwd, sessionId)` (in `shared.ts`):

- `loadSnapshot(sessionId)` → `snapshotManifests(cwd)` → `detectLeaks` (flags `flagged` leaks always; `isOsvChecked:false` leaks under the fail-closed toggle) → `pinManifestChanges` rewrites newly-added range deps to exact safe pins → `writeFileSync` per changed manifest → `saveSnapshot(sessionId, next)` (the next event diffs from the corrected state).
- Leak output lands in `additionalContext`: `[Package Sentinel] <n> flagged dep(s) leaked: <name@version, ...> - rollback recommended`.
- Stop-only: when no supported manifest is **at** `cwd` but an **unsupported** dependency manifest is present (`Gemfile`, `go.mod`, `composer.json`, `build.gradle`, `pom.xml`, `Gemfile.lock`, `go.sum` - `UNSUPPORTED_MANIFESTS` in `shared.ts`), the handler emits `[Package Sentinel] unsupported manifest (<name>) - dependencies NOT vetted` instead of staying silent.

**Cross-process state** (`shared.ts`): hooks run as separate processes per event, so the before-snapshot persists in `dataDir()` - `CLAUDE_PLUGIN_DATA/package-sentinel` when set, else `<os tmpdir>/package-sentinel` - as `snap-<safe>.json` (session id sanitized to `[A-Za-z0-9_.-]`, default `anon`). `SNAPSHOT_TTL_MS = 24h`: a stale or unreadable snapshot is treated as absent. `saveSnapshot` writes to `.<pid>.tmp` and renames (atomic, concurrent-hook safe). Both the state dir and snapshot files are permission-restricted (dir `0o700`, snapshot files `0o600`) - they hold manifest contents.

**CLI** (`cli.ts`, installed on PATH via `bin/package-sentinel` shim → `main()`):

- `assert <spec>...` - one verdict line per spec (`name@version` or `name==version` via `parseSpec`); exit 1 when any target is blocked (including "no supported manifest in cwd; not vetted" and "no verdict" cases), 0 otherwise; usage error exits 2.
- `vet <name> <version>` - single-spec verdict via `vetSpec`, same exit semantics.
- `audit [--json] [--exclude <dirs>]` - `auditAllManifests` over the whole tree; prints `audit FAIL: <n> blocked across <m> manifest(s)` or `audit OK (<m> manifest(s))`; exit 1 when anything is blocked (CI-gate usable). `--json` prints `{ manifests, blocked }`.
- Every invocation prints `LICENSE_NOTICE` (short Apache-2.0 notice referencing LICENSE.md).

## Runtime parity: Pi ↔ Claude Code

Same vetting core, two surfaces; the Pi adapter's AGENTS.md carries this table from the other direction.

> NOTE: Pi refers to the Pi agent harness ([https://pi.dev/](https://pi.dev/)), **not** Raspberry Pi.

| Pi adapter (pi-package-sentinel)       | Claude Code adapter (this package)                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `tool_call` gate                       | `PreToolUse` hook → `permissionDecision: "deny"` on blocked installs                         |
| `tool_execution_start` snapshot        | `PreToolUse` - persists the before-snapshot keyed by `session_id`                            |
| `tool_execution_end` leak detect + pin | `PostToolUse` - snapshot diff, flag leaks (`additionalContext`), pin range deps (write-back) |
| `turn_end` safety net                  | `Stop` hook - last leak scan + pin + unsupported-manifest note                               |
| `assert_installable` tool              | `package-sentinel` CLI (`assert` / `vet`) + `/package-sentinel:assert-installable` command   |
| `/audit` command                       | `package-sentinel audit [--json]` - full-manifest scan, non-zero exit if anything is blocked |

Known parity divergence: the Pi adapter's shell-command parser also extracts from `fetch` commands; the Claude adapter's `targetsFromCommand` matches only `add`/`install`/`require`/`save`. `commands/audit.md` and `commands/assert-installable.md` provide the slash-command surfaces the table references.

## Invariants

- **Fail-open by default, loud when so:** deny only `flagged`/too-new; an OSV-unconfirmed pass ships the "not vetted" reason with its `allow`. Covered by core tests (`OSV-miss gate: fail-open by default, fail-closed under toggle`, `a too-new version blocks in BOTH modes`) and adapter wiring tests.
- **The pin path never auto-writes an unvetted version:** write-back happens only for pins the vetter returned as non-blocked; leaks are surfaced, never pinned or silently accepted.
- **The gate only sees the four matched tools**; everything else is caught by Firing Point 2 (`runPostWrite`, including the Stop turn-end net).
- **A clean pin rewrite is silent:** `additionalContext` is emitted only for leaks (and the Stop unsupported-manifest note) - a range→exact pin with no leaks rewrites the manifest without a notice.
- Snapshot handling: atomic write-then-rename, 24h TTL, session-keyed - concurrent hooks never read a torn file, and stale state can't produce a false "no leak" diff.

## Files

- `hooks/hooks.json` - the three hook registrations (PreToolUse matcher `Bash|Write|Edit|NotebookEdit`).
- `hooks-handlers/handler.ts` - stdin event → firing-point dispatch; hook-convention stdout JSON.
- `shared.ts` - Claude Code glue: `readEvent`, snapshot state (`saveSnapshot`/`loadSnapshot`/`dataDir`), `extractInstallTargets` (+`targetsFromCommand`, `parseSpec`), `runPostWrite`, unsupported-manifest detection.
- `cli.ts` - the `package-sentinel` CLI (`assert`/`vet`/`audit`); `bin/package-sentinel` is the PATH shim delegating to `main()`.
- `commands/assert-installable.md`, `commands/audit.md` - slash commands.
- `.claude-plugin/plugin.json` - plugin manifest (name `package-sentinel`).
- `test/` - `wiring.test.ts` (+ `expect.ts`) adapter wiring tests; `e2e.live.test.ts` live hook-boundary e2e (network-gated, runs only under `RUN_LIVE_TESTS=1`).
- `scripts/e2e.sh` - launcher for the live hook-boundary backstop.

## Testing & validation

```bash
npx tsc --noEmit   # strict typecheck of this adapter (package script "check")
npm test           # wiring + e2e tests (node --test): 20 tests - 15 pass, 5 live-skipped by default
scripts/e2e.sh     # the live backstop: real OSV + npm through the spawned handler process (network; no LLM)
```

The vetting unit suites (76 tests) run in `package-sentinel-core` - see its AGENTS.md. Coverage of the wiring:

| Area               | What it proves                                                                | File                  |
| ------------------ | ----------------------------------------------------------------------------- | --------------------- |
| Claude Code wiring | target extraction from `Bash`/`Write`; unsupported-manifest "not vetted" note | `test/wiring.test.ts` |

The handlers and CLI were smoke-tested against the live npm registry + OSV (deny on a vulnerable version, leak flag, range → exact pin write-back). `scripts/e2e.sh` automates the same scenarios through the real process boundary: AC-3 gate deny (`lodash@4.17.19`), safe-version non-block (`is-number@7.0.0`), PostToolUse leak flag + rollback advice, range→exact pin write-back, and the Stop hook's unsupported-manifest note. The Pi adapter keeps its own in-process harness in `../pi-package-sentinel/scripts/e2e.sh`.
