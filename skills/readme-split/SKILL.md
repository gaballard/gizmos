---
name: readme-split
description: Split a package README into a purely end-user README.md plus an engineering AGENTS.md, and keep docs tone/organization consistent across sibling surfaces of the same tool (e.g. a -core engine plus pi-* and claude-*/opencode-* adapters). Use when asked to "split the README", "move the nitty-gritty to AGENTS.md", "reconcile/refresh AGENTS.md and README.md", or "make the docs consistent across the pi/claude/openai versions of this package".
license: Apache-2.0
---

# README ↔ AGENTS.md split

One rule governs the split, stated in every AGENTS.md: **README.md is for people who have never heard of the repo; AGENTS.md is for agents and contributors. Keep the two consistent when you edit either.**

## Step 1 — Inventory

- Read the target README in full. Check whether AGENTS.md already exists and read it if so; sibling packages likely already point at it ("full module tour in its AGENTS.md") — prefer **merging into it** over rewriting from scratch.
- Grep the repo for pointers into the package (`<pkg>/AGENTS.md`, "see its README", cross-links from siblings) so everything referenced gets delivered and nothing dangles after the move.

## Step 2 — Find the template surfaces

Sibling packages of the same tool are the style template: read each sibling's README.md **and** AGENTS.md first. Match their section order and heading names, the opening-sentence pattern (each README opens with the same plain one-liner about the tool), table style, `_Note: ..._` italics, and the AGENTS.md opening: "Engineering reference for X. The end-user story ... lives in README.md - keep the two consistent when you edit either."

## Step 3 — Classify every block of content

| Goes to README.md (end-user)                     | Goes to AGENTS.md (engineering)                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| What it is, for someone with zero repo context   | How it works: per-module tour with signature snippets                             |
| Install path (or a pointer to an implementation) | The design why, in one paragraph (the non-obvious force that shaped the approach) |
| Behavior/verdicts the user observes (tables)     | Decision order, thresholds, and edge semantics                                    |
| Coverage scope in user terms (manifests, limits) | Config knobs **with source locations**; consumers; cross-surface parity table     |
| Runtime flags users actually set                 | Invariants: hard one-line promises the code must keep                             |
| Latency/UX the user feels; disclaimers; license  | Files, testing & validation with commands and per-area coverage table             |

Rule of thumb: code samples, internal constants, env-file parsing details, and decision-order internals are nitty-gritty → AGENTS.md. Anything installable or observable by an end user stays in README.md. If the package is a core/engine used largely through adapters, the README's job is to send the reader to an implementation: link each sibling surface with a one-line what-it-is, then state that "both load the same engine, so the verdicts/coverage/flags below apply to whichever one you pick."

## Step 4 — Fact-check before writing

Do not trust the existing README. Verify against source: exports cited by code samples, constants (thresholds, caps, env parsing values), error-message phrasing, behaviors promised by tables. Wrong docs are worse than split docs.

## Step 5 — Write or merge AGENTS.md

Intro (routing sentence) → design why → module tour (per module: signature block + one short paragraph, including what it deliberately does **not** do) → consumers table → config table with source locations → testing table → invariants. Source locations are **file + symbol name, never line numbers** - they drift on every edit and rot the docs. Cross-reference sibling AGENTS.md files, and keep one parity table mirrored in both directions (same rows; each file points at the other's).

## Step 6 — Rewrite README.md

Mirror the chosen sibling template's structure: title `# Tool Name (Surface)` — e.g. `(Core)`, `(Claude Code)`, `(Pi)` — badge, the shared opening one-liner(s), then end-user sections in the sibling's order (Installation → Configuration → Usage/behavior → verdicts → coverage → security/latency → disclaimers → license → resources), trimmed to what applies to this package. A core package substitutes the install sections with the implementations pointer; do not keep Quick Start code, internal thresholds tables, or source-location notes there.

## Step 7 — Consistency pass across sibling surfaces

- Shared facts use the same headings and near-verbatim wording across sibling READMEs (verdicts table, coverage table, runtime flags, the opening sentence).
- Every AGENTS.md intro points at its siblings; mirrored parity tables agree in both directions.
- No dangling references: grep for names of sections that moved or vanished (e.g. "Quick Start").

## Step 8 — Format and verify

Run prettier on the touched markdown (repo `.prettierrc` when present, else `npx prettier --write README.md AGENTS.md`). Done when: every claim left in README is user-level, every claim in AGENTS.md is checkable against source, all promised cross-references resolve, and the sibling surfaces read as one story told twice at two depths.
