---
name: assert-installable
description: Vet package/version specs against the detected registry and OSV vulnerability advisories before installing or saving a dependency. Use this when adding or changing a dependency in package.json, requirements.txt, Pipfile, pyproject.toml, or Cargo.toml - e.g. "assert lodash@4.17.19 requests==2.28.2" - or to double-check a version the user proposes to pin.
---

Run the bundled Package Sentinel CLI against each spec and act on the verdicts.

For each spec (format `name@version` for npm/crates or `name==version` for pip), run:

```
package-sentinel assert $ARGUMENTS
```

The `package-sentinel` executable is on your PATH because this plugin is enabled. If it is not, run it directly with:

```
node "${CLAUDE_PLUGIN_ROOT}/cli.ts" assert $ARGUMENTS
```

Rules:

- A `safe` verdict means the version is fine to install and pin.
- A `needs_review` verdict (stale or OSV-unchecked) is a warning: surface it to the user, and do not silently proceed. A **too-new** version (published < 7 days ago) is a **hard block** - treat it like `flagged`: do NOT install, save, or pin it; choose the suggested alternative or report "no safe version known".
- A `flagged` verdict (a published vulnerability - always; or, under `PACKAGE_SENTINEL_FAIL_CLOSED=1`, an OSV check that did not complete) is a hard block: do NOT install, save, or pin that version. Choose the suggested alternative from the output, or report "no safe version known" if none is given and stop. Under the default fail-open mode an unverified verdict is allowed but surfaces a loud "not vetted" warning - tell the user.

Report the verdict lines back to the user.
