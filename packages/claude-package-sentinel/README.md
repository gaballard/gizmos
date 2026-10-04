# Package Sentinel (Claude Code)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Package Sentinel is a tool that stops your agent from installing or saving vulnerable package versions.

It vets every package version your agent is about to install or save - from NPM, PyPI, or crates.io - against [OSV](https://osv.dev), the open vulnerability database, before the install runs. A known-vulnerable version is blocked, as are versions published less than 7 days ago (a supply-chain cooldown that gives the community time to detect attacks).

As a second line of defense, it re-reads your manifests (`package.json`, `pyproject.toml`, `requirements.txt`, `Pipfile`, `Cargo.toml`) after each tool run and again at the end of every turn, warning if any vulnerable versions were saved.

Package Sentinel is also available as a [Pi](https://pi.dev/) coding agent extension at [`pi-package-sentinel`](../pi-package-sentinel/).

## Installation

Install from the repo's plugin marketplace (`.claude-plugin/marketplace.json` at the repo root):

```bash
claude plugin marketplace add /path/to/gizmos
claude plugin install package-sentinel@gizmos
```

Or install directly from source:

```bash
# 1. Install the shared core + the plugin's CLI (runs once, per checkout)
cd packages/claude-package-sentinel && npm install

# 2. Make the agent use it - either per-session...
claude --plugin-dir /path/to/gizmos/packages/claude-package-sentinel

# ...or for every session:
cp -R packages/claude-package-sentinel ~/.claude/skills/package-sentinel
```

_Note: This plugin is a wrapper around the vetting logic in [`package-sentinel-core`](../package-sentinel-core/)._

## Configuration

The plugin requires zero configuration. Load it once and it runs automatically in any project with a supported manifest.

### Runtime flags

- `PACKAGE_SENTINEL_FAIL_CLOSED`: Set to `1` to deny any install or save that OSV did not positively confirm (unchecked, not listed, registry unknown, etc.). Note that dependencies outside the registry - e.g. local/monorepo packages - can only pass under the default fail-open mode. Defaults to `0` (fail open).

## Usage

Once installed, Package Sentinel will run automatically in any project with a supported manifest - no need to do anything.

### Commands

- `/package-sentinel:audit`: Vets every manifest in the current working directory (subfolders included) and returns a report. Use `--json` for machine-readable output and `--exclude <folders>` to skip subfolders.
- `/package-sentinel:assert-installable`: Vets a proposed version before saving it.

### Tools

- `package-sentinel`: CLI tool to vet a proposed version before saving it. Available on the Bash tool's $PATH while the plugin is enabled. Used by the `assert-installable` command.

_Note: the CLI exits with a non-zero code when any packages are blocked (slash commands do not), so you can e.g. gate CI runs with `package-sentinel audit`._

## What you'll see in a session

- **A blocked install.** If your agent tries `npm install lodash@4.17.19` and that version has a published advisory, the install is refused with the reason and the nearest safe alternative (`try 4.18.1 (safe)`), so the agent can pick it.
- **A "not vetted" warning.** If OSV could not confirm a version (outage, not listed, unknown to the registry), the install proceeds - but you get a loud warning naming each unvetted package, so nothing unsafe passes silently.
- **An `/audit` report.** Run it any time to vet every dependency in every supported manifest under your project folder: e.g. `audit OK (3 manifests)` or `audit FAIL: 2 blocked across 3 manifests` followed by a per-dependency verdict list.
- **A turn-end leak check.** If an install bypassed the upfront gate (a tool Package Sentinel does not see), it is caught at the end of the turn and raised as an error notice.

## Verdicts

One line per package:

```text
lodash@4.17.21: flagged - vulnerable: GHSA-f23m-r3pf-42rh, ... - try 4.18.1 (safe)
express@4.18.0: needs_review - published 2d ago; too new - try 4.17.21 (safe)   # too-new blocks; recommendation is the newest confirmed-safe
requests@2.31.0: safe - no advisory, reasonable recency
```

| Verdict                           | What happens                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `safe`                            | Allowed. Range deps added as `safe` are pinned to the exact version.                                |
| `flagged`                         | Blocked. A published vulnerability matches - the vetting suggests the nearest safe version instead. |
| `needs_review` (too new)          | Blocked. Published < 7 days ago - supply-chain cooldown.                                            |
| `needs_review` (stale / unvetted) | Allowed with a warning. Older than 365 days and not the newest, or the OSV check didn't complete.   |

## What the Sentinel covers, and what it doesn't

**In scope:** the _direct_ dependencies of the first supported manifest at your project working directory:

| Manifest                                        | Ecosystem | Registry           | Advisory source |
| ----------------------------------------------- | --------- | ------------------ | --------------- |
| `package.json`                                  | npm       | registry.npmjs.org | OSV             |
| `pyproject.toml`, `requirements.txt`, `Pipfile` | PyPI      | pypi.org           | OSV             |
| `Cargo.toml`                                    | Rust      | crates.io          | OSV             |

**Out of scope:**

- Transitive / lockfile graphs - direct dependencies only (no SBOM or full supply-chain audit).
- Go, RubyGems, Composer ecosystems. If no supported manifest is present but a `Gemfile`, `go.mod`, `composer.json`, `build.gradle`, `pom.xml`, `Gemfile.lock`, or `go.sum` is, turn-end gives a loud "dependencies NOT vetted" note instead of staying silent.
- Tools outside the `Bash|Write|Edit|NotebookEdit` matcher. Installs through an MCP tool, a sub-agent, or a download (`WebFetch`, `curl`) are not gated up front - they are caught by the post-write / turn-end check and flagged for rollback.

## Security policies

- **Blocks by default on flagged and too-new; fail-open on OSV-miss.** A version `flagged` (a known OSV advisory) and any **too-new** version (published < 7 days ago - supply-chain cooldown) block unconditionally; a version whose OSV check did not complete (unchecked / not listed) is allowed unless you set `PACKAGE_SENTINEL_FAIL_CLOSED=1`, which restores deny-on-unconfirmed. An unconfirmed pass is never silent: you get a loud "not vetted" notice naming the packages.
- **The pin path never auto-writes an unvetted version.** New manifest entries are rewritten only to pins the vetter returned as non-blocked; a leaked vulnerable dep is flagged ("rollback recommended"), never silently accepted or pinned.
- **The upfront gate only sees the four matched tools.** Anything it can't gate immediately is caught by the post-write / turn-end check.

## Latency

Every gated install-target check performs a vetted lookup (registry + OSV) before the install proceeds. On a cache miss that's a network round-trip; on OSV/registry failure the verdict becomes `needs_review` - under the default fail-open mode the install is allowed with a loud "not vetted" warning (set `PACKAGE_SENTINEL_FAIL_CLOSED=1` to deny).

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/claude-package-sentinel/LICENSE.md)

## Resources

- [package-sentinel-core](../package-sentinel-core/) - Shared library with core logic
- [pi-package-sentinel](../pi-package-sentinel/) - Pi coding agent version of this tool
- [Open Vulnerability Database](https://osv.dev)
- [Claude Code](https://code.claude.com/)
