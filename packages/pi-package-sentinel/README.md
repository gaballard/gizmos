# Package Sentinel (Pi)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Package Sentinel is a tool that stops your agent from installing or saving vulnerable package versions.

It vets every package version your agent is about to install or save - npm, PyPI, or crates.io - against [OSV](https://osv.dev), the open vulnerability database, before the install runs. A known-vulnerable version is blocked, and so is a version published less than 7 days ago (a supply-chain cooldown that gives the community time to detect attacks).

As a second line of defense, it re-reads your manifests (`package.json`, `pyproject.toml`, `requirements.txt`, `Pipfile`, `Cargo.toml`) after each tool run and again at the end of every turn, warning if any vulnerable versions were saved.

Package Sentinel is also available as a [Claude Code](https://code.claude.com/) plugin at [`claude-package-sentinel`](../claude-package-sentinel/).

## Installation

Install from source (the npm package is planned but not yet published, so the registry form doesn't resolve yet):

```bash
pi install /path/to/gizmos/packages/pi-package-sentinel
```

Once published:

```bash
pi install npm:@gizmos/pi-package-sentinel
```

_Note: This extension is a wrapper around the vetting logic in [`package-sentinel-core`](../package-sentinel-core/)._

## Configuration

The extension requires zero configuration. Load it once and it runs automatically in any project with a supported manifest.

### Runtime flags

- `PACKAGE_SENTINEL_FAIL_CLOSED`: Set to `1` to deny any install or save that OSV did not positively confirm (unchecked, not listed, registry unknown, etc.). Note that dependencies outside the registry - e.g. local/monorepo packages - can only pass under the default fail-open mode. Defaults to `0` (fail open).

## Usage

Once installed, Package Sentinel will run automatically in any project with a supported manifest - no need to do anything.

### Commands

- `/audit`: Vets every manifest in the current working directory (subfolders included) and returns a report. Use `--json` for machine-readable output and `--exclude <folders>` to skip subfolders.

### Tools

- `assert_installable`: Tool to vet a proposed version before saving it.

_Note: `/audit` reports FAIL/OK in-session; it does not set a process exit code._

## What you'll see in a session

- **A blocked install.** If your agent tries `npm install lodash@4.17.19` and that version has a published advisory, the install is refused with the reason and the nearest safe alternative (`try 4.18.1 (safe)`), so the agent can pick it.
- **A "not vetted" warning.** If OSV could not confirm a version (outage, not listed, unknown to the registry), the install proceeds - but you get a loud warning naming each unvetted package, so nothing unsafe passes silently.
- **A `/audit` report.** Run it any time to vet every dependency in every supported manifest under your project folder: e.g. `audit OK over 3 manifest(s)` or `audit FAIL (2 blocked)` followed by a per-dependency verdict list.
- **A turn-end leak check.** If an install bypassed the upfront gate (a tool Package Sentinel does not see), it is caught at the end of the turn and raised as an error notice.

## Verdicts

One line per package:

```text
lodash@4.17.21: flagged - vulnerable: GHSA-f23m-r3pf-42rh, ... - try 4.18.1 (safe)
express@4.18.0: needs_review - published 2d ago; too new - try 4.17.21 (safe)
requests@2.31.0: safe - no advisory, reasonable recency
```

| Verdict                           | What happens                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `safe`                            | Allowed. Range deps added as `safe` are pinned to the exact version.                                |
| `flagged`                         | Blocked. A published vulnerability matches - the vetting suggests the nearest safe version instead. |
| `needs_review` (too new)          | Blocked. Published < 7 days ago - supply-chain cooldown.                                            |
| `needs_review` (stale / unvetted) | Allowed with a warning. Older than 365 days and not the newest, or the OSV check didn't complete.   |

## What the Sentinel covers, and what it doesn't

**In scope:** the direct dependencies of the **first** supported manifest at your project working directory:

| Manifest                                        | Ecosystem | Registry           | Advisory source |
| ----------------------------------------------- | --------- | ------------------ | --------------- |
| `package.json`                                  | npm       | registry.npmjs.org | OSV             |
| `pyproject.toml`, `requirements.txt`, `Pipfile` | PyPI      | pypi.org           | OSV             |
| `Cargo.toml`                                    | Rust      | crates.io          | OSV             |

**Out of scope by design:**

- Transitive / lockfile graphs - direct dependencies only (no SBOM or full supply-chain audit).
- Go, RubyGems, Composer ecosystems. If no supported manifest is present but a `Gemfile`, `go.mod`, `composer.json`, `build.gradle`, `pom.xml`, `Gemfile.lock`, or `go.sum` is, turn-end gives a loud "dependencies NOT vetted" note instead of staying silent.
- The gate in this Pi surface fires on tool calls generally. Installs through an MCP tool, a sub-agent, or a download are not gated up front - they are caught by the post-write / turn-end check and flagged for rollback.

## Security policies

- **Blocks by default on flagged and too-new; fail-open on OSV-miss.** A version `flagged` (a known OSV advisory) and any **too-new** version (published < 7 days ago - supply-chain cooldown) block unconditionally; a version whose OSV check did not complete (unchecked / not listed) is allowed unless you set `PACKAGE_SENTINEL_FAIL_CLOSED=1`, which restores deny-on-unconfirmed. An unconfirmed pass is never silent: you get a loud "not vetted" notice naming the packages.
- **The pin path never auto-writes an unvetted version.** New manifest entries are rewritten only to pins the vetter returned as non-blocked; a leaked vulnerable dep is flagged ("rollback recommended"), never silently accepted or pinned.
- **The gate fires on tool calls generally.** Whatever it can't gate up front is caught by the post-write / turn-end check.

## Latency

Every gated install-target check performs a vetted lookup (registry + OSV) before the install proceeds. On a cache miss that's a network round-trip; on OSV/registry failure the verdict becomes `needs_review` - under the default fail-open mode the install is allowed with a loud "not vetted" warning (set `PACKAGE_SENTINEL_FAIL_CLOSED=1` to deny).

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/pi-package-sentinel/LICENSE.md)

## Resources

- [package-sentinel-core](../package-sentinel-core/) - Shared library with core logic
- [claude-package-sentinel](../claude-package-sentinel/) - Claude Code version of this tool
- [Open Vulnerability Database](https://osv.dev)
- [Pi coding agent](https://pi.dev)
