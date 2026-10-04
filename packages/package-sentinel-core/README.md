# Package Sentinel (Core)

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Package Sentinel is a tool that stops your agent from installing or saving vulnerable package versions.

It vets every package version your agent is about to install or save - from NPM, PyPI, or crates.io - against [OSV](https://osv.dev), the open vulnerability database, before the install runs. A known-vulnerable version is blocked, as are versions published less than 7 days ago (a supply-chain cooldown that gives the community time to detect attacks).

This package is the vetting engine both implementations are built on: it resolves a package's published versions from its registry, queries OSV for advisories about the exact version, and returns a verdict - with no agent code attached. If you want Package Sentinel in your coding agent, install one of the implementations:

- [`@gizmos/pi-package-sentinel`](../pi-package-sentinel/) - the [Pi](https://pi.dev/) extension (this repo's default)
- [`@gizmos/claude-package-sentinel`](../claude-package-sentinel/) - the [Claude Code](https://code.claude.com/) plugin

Both adapters load the same engine here, so the verdicts, coverage, and runtime flag below apply to whichever one you pick.

_Note: the npm package for this core is planned but not yet published; the adapters install it from a checkout of this repo._

## Verdicts

Every vetted package version gets one of three verdicts:

| Verdict                           | What happens                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `safe`                            | Allowed. Range deps added as `safe` are pinned to the exact version.                                |
| `flagged`                         | Blocked. A published vulnerability matches - the vetting suggests the nearest safe version instead. |
| `needs_review` (too new)          | Blocked. Published < 7 days ago - supply-chain cooldown.                                            |
| `needs_review` (stale / unvetted) | Allowed with a warning. Older than 365 days and not the newest, or the OSV check didn't complete.   |

## What it covers

**In scope:** the direct dependencies that live in these supported manifests:

| Manifest                                        | Ecosystem | Registry           | Advisory source |
| ----------------------------------------------- | --------- | ------------------ | --------------- |
| `package.json`                                  | npm       | registry.npmjs.org | OSV             |
| `pyproject.toml`, `requirements.txt`, `Pipfile` | PyPI      | pypi.org           | OSV             |
| `Cargo.toml`                                    | Rust      | crates.io          | OSV             |

**Out of scope by design:**

- Transitive / lockfile graphs - direct dependencies only (no SBOM or full supply-chain audit).
- Go, RubyGems, Composer ecosystems.

## Configuration

The engine has no configuration surface of its own - the implementations load it and expose one shared runtime flag:

- `PACKAGE_SENTINEL_FAIL_CLOSED`: Set to `1` to deny any install or save that OSV did not positively confirm (unchecked, not listed, registry unknown, etc.). Note that dependencies outside the registry - e.g. local/monorepo packages - can only pass under the default fail-open mode. Defaults to `0` (fail open).

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

- License: [Apache 2.0](https://github.com/gaballard/gizmos/blob/main/packages/package-sentinel-core/LICENSE.md)

## Resources

- [claude-package-sentinel](../claude-package-sentinel/) - Claude Code implementation
- [pi-package-sentinel](../pi-package-sentinel/) - Pi coding agent implementation
- [Open Vulnerability Database](https://osv.dev)
