# Little Shop of Gizmos

![LLM Use - Code Generation](https://img.shields.io/badge/LLM%20Use-Code%20Generation-blue.svg) ![Open Models Only](https://img.shields.io/badge/-Open%20Models%20Only-green.svg)

Plugins, skills, and utilities for LLM-assisted development workflows.

## Packages

### Pi extensions

| Package                       | What it does                                          |
| ----------------------------- | ----------------------------------------------------- |
| `@gizmos/pi-package-sentinel` | Vulnerable-package gate + `/audit` full-manifest scan |

### Claude Code plugins

| Package                           | Runtime     | What it does                                                  |
| --------------------------------- | ----------- | ------------------------------------------------------------- |
| `@gizmos/claude-package-sentinel` | Claude Code | Package Sentinel as a Claude Code plugin (gate + `audit` CLI) |

### Shared core

| Package                 | Used by                                      |
| ----------------------- | -------------------------------------------- |
| `package-sentinel-core` | pi-package-sentinel, claude-package-sentinel |

## Install

Nothing here is on a registry yet - install from a checkout of this repo.

### Pi

```bash
git clone https://github.com/gaballard/gizmos && cd gizmos
npm install                                        # links workspace deps (package-sentinel-core)
pi install ./packages/pi-package-sentinel          # Package Sentinel
```

`pi install <local-path>` loads the package from that directory in place (no copy), so edits in the checkout take effect without reinstalling. Every directory under `packages/` that starts with `pi-` installs the same way; each installs individually. Extensions auto-load from `~/.pi/agent/extensions` / project `.pi/extensions`.

### Claude Code

Load a plugin for this session:

```bash
claude --plugin-dir ./packages/claude-package-sentinel   # Package Sentinel
```

Or install as a skills-dir plugin (auto-loads every session):

```bash
cp -R ./packages/claude-package-sentinel ~/.claude/skills/package-sentinel
```

Or register your checkout as a marketplace (the marketplace root is the dir containing `.claude-plugin/marketplace.json`), then install from it:

```bash
claude plugin marketplace add /path/to/gizmos
claude plugin install package-sentinel@gizmos
```

Validate a manifest any time with `claude plugin validate packages/claude-package-sentinel/.claude-plugin/plugin.json`.

## Skills

Author-workflow skills live in `skills/` - one directory per skill with a `SKILL.md` (Agent Skills format). The repo is the single source of truth; symlink into the skills directories your runtimes scan, so they load globally (Pi's discovery follows symlinks and dedupes by realpath, so nothing double-loads):

| Skill          | What it does                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readme-split` | Splits a package README into an end-user README plus AGENTS.md, and keeps docs tone-consistent across sibling surfaces (core / Pi / Claude Code variants). |

```bash
ln -s /path/to/gizmos/skills/readme-split ~/.agents/skills/readme-split   # Pi + Agent-Skills-spec runtimes
ln -s /path/to/gizmos/skills/readme-split ~/.claude/skills/readme-split   # Claude Code
```

## AI Use Disclaimer

This codebase has been built with the support of open-weight and open-source LLMs. Use of closed models is not allowed for any purpose.

## License

Apache-2.0. All source carries an SPDX header; the full text lives in [`LICENSE.md`](LICENSE.md).
