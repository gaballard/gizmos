---
name: audit
description: Audit every dependency in every detected manifest (package.json, requirements.txt, Pipfile, pyproject.toml, or Cargo.toml) against the registry and OSV advisories, including manifests in subfolders (monorepos). Use for a periodic security sweep, before a release, or when the user asks whether their dependencies are safe - it vets existing dependencies, not just new installs. Append --json for machine-readable output; --exclude <dirs> to skip extra folders.
---

Run the full-manifest audit:

```
package-sentinel audit
```

For machine-readable output (exits non-zero when anything is blocked, so it can gate CI):

```
package-sentinel audit --json
```

To also skip custom folders beyond the defaults:

```
package-sentinel audit --exclude vendor,legacy-apps
```

Rules:

- Every dependency in every manifest found at or below the cwd is vetted - not just recently added ones. An exact spec (`4.17.21`) is vetted directly; a range (`^4.18.0`) is resolved to the newest matching version first.
- Subfolder scanning skips junk by default (`node_modules`, `dist`, `build`, `out`, `coverage`, `target`, `.git`, `.next`, `.venv`, `venv`, `__pycache__`); `--exclude foo,bar` adds more, matched by folder name or cwd-relative path.
- A `flagged` or **too-new** entry is a hard block: propose the suggested safe alternative from the output, or report "no safe version known" if none is given.
- An entry marked `(unverified - fail-open)` passed because OSV could not confirm it (outage or not listed) - surface that to the user rather than treating it as safe.
- Report the verdict list back to the user, worst first, grouped by the manifest path that was audited.
