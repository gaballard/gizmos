/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime-agnostic core for the sanity-check cross-model agree/disagree loop.
// No Pi/OpenCode/Claude imports - pure logic only, so any adapter can reuse it
// and it's unit-testable. Run the runtime self-check: node packages/sanity-check-core/src/self-check.ts

/** Explicitly-nullable field type (style guide §2): use for fields that are
 *  always present but may hold null/undefined; reserve `?` for fields that are
 *  genuinely absent. */
export type Nullable<T> = T | null | undefined;

export const MAX_ROUNDS = 3;

export const REVIEWER_SYSTEM = `You are an independent critical reviewer. Adopt the perspective
of a CTO and apply any agent-personas relevant to this deliverable (security,
architecture, backend, LLM/agent, frontend, performance). You did NOT produce
this work - your only job is to find weaknesses.

Review the deliverable skeptically but constructively. Address: security,
correctness, maintainability; assumptions that could silently fail; missing
edge cases, requirements, or scope; logical gaps and hidden dependencies.

Return exactly:
1. A 2-3 sentence overall summary.
2. Findings, each severity-tagged 🔴 High / 🟡 Medium / 🟢 Low, with the
   specific problem, why it matters, and a concrete fix.
3. A short "what would have to be true for this to be right" note.
End the report with a line: AGREE: <yes|no> - replace <yes|no> with the single
word yes or no. Do not echo this instruction line.`;

export const PRODUCER_SYSTEM = `You produced a deliverable. An independent reviewer (a CTO
applying relevant personas) returned findings. We seek AGREEMENT between you
and the reviewer.

Revise the deliverable to genuinely address each High and Medium finding -
fix it, or explicitly explain in one line why the concern does not apply
(with reasoning, not dismissal). Do not over-fit to Low/polish items.

Return the REVISED deliverable first, then a short changelog:
- [resolved] <finding>
- [disputed] <finding> - <one-line reason>`;

export const blocksToText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = content
    .map((b: any) => (b?.type === 'text' ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
  if (text.trim()) return text;
  // Reasoning models can exhaust the output budget inside the thinking phase
  // and emit ONLY a `thinking` block (stopReason "length") with no text block.
  // Fall back to that thinking so a review/revision isn't silently empty - an
  // empty `revise()` result was being fed to B as an empty deliverable on
  // rounds after the 1st (and an empty review was refused as convergence).
  return (
    content
      .map((b: any) => (b?.type === 'thinking' ? (b.thinking ?? '') : ''))
      .filter(Boolean)
      .join('\n') || ''
  );
};

/**
 * Pull the most recent assistant message's text out of a session's entry
 * list. Handles both session-entry shapes defensively: an entry may be shaped
 * `{ role, content }` directly, or wrap the agent message as `{ message:
 * { role, content } }`. Content is a block array `[{type:"text", text}]`.
 * Returns "" when no assistant message exists (e.g. a brand-new session).
 */
export const extractLastAssistantText = (entries: Array<{ [k: string]: unknown }>): string => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] ?? {};
    const msg = (e.message && typeof e.message === 'object' ? e.message : e) as {
      role?: unknown;
      content?: unknown;
    };
    if (msg.role !== 'assistant') continue;
    const text = blocksToText(msg.content);
    if (text.trim()) return text;
  }
  return '';
};

// A reviewer verdict: explicitly agreed or not (undefined = no usable AGREE line),
// plus how many High / Medium findings its report contains.
export interface Verdict {
  isAgreed: Nullable<boolean>;
  high: number;
  medium: number;
  isFormatFollowed: boolean;
  hasBody: boolean;
}

/** Explicit AGREE: yes|no line, or undefined when absent. Anchored to the
 *  LAST match: a reviewer that echoes the prompt's template line (`AGREE:
 *  yes|no`) or quotes a prior round mid-body must not satisfy the verdict -
 *  only the report's closing verdict counts (Track A FR-1,
 *  sanity-check-verdict-parsing). */
export const parseAgree = (text: string): boolean | undefined => {
  const re = /AGREE:\s*(yes|no)\b/gi;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) last = m;
  if (last) return last[1].toLowerCase() === 'yes';
  return undefined;
};

/** The outcome of a one-shot completion: a real body, an aborted request, or
 *  a provider/transport error. A provider 4xx must not be mistaken for "the
 *  reviewer had nothing to say" (Track B FR-1, sanity-check-blank-review-body). */
export type CompletionKind = 'body' | 'aborted' | 'provider-error';

export interface CompletionOutcome {
  kind: CompletionKind;
  text: string;
  reason?: string;
}

/**
 * Classify a resolved completion result. Anything whose `stopReason` is not a
 * normal completion is a failure, not an empty body: `error` becomes
 * `provider-error`, an abort becomes `aborted`. Only a normal stop yields a
 * `body` (whose text may still legitimately be empty).
 */
export const classifyCompletion = (res: {
  stopReason?: unknown;
  content?: unknown;
  errorMessage?: unknown;
}): CompletionOutcome => {
  const stopReason = typeof res?.stopReason === 'string' ? res.stopReason : undefined;
  const errorMessage =
    typeof res?.errorMessage === 'string' && res.errorMessage.trim()
      ? res.errorMessage.trim()
      : undefined;
  const isAbort =
    stopReason === 'aborted' ||
    /abort/i.test(stopReason ?? '') ||
    /abort/i.test(errorMessage ?? '');
  if (isAbort) {
    return { kind: 'aborted', text: '', reason: errorMessage ?? 'request aborted' };
  }
  if (stopReason === 'error') {
    return {
      kind: 'provider-error',
      text: '',
      reason: errorMessage ?? 'provider returned an error',
    };
  }
  return { kind: 'body', text: blocksToText(res?.content).trim() };
};

/** Classify a thrown completion (adapters whose transport rejects rather than
 *  returning a `stopReason`). */
export const classifyThrownCompletion = (err: unknown): CompletionOutcome => {
  const message = err instanceof Error ? err.message : String(err);
  return {
    kind: /abort/i.test(message) ? 'aborted' : 'provider-error',
    text: '',
    reason: message,
  };
};

/** Human-facing reason for a non-`body` completion, so convergence never blames
 *  the reviewer's output format for a transport failure (Track B FR-4). */
export const completionFailureReason = (o: CompletionOutcome): string =>
  o.kind === 'aborted'
    ? `reviewer call was aborted at the transport layer (${o.reason ?? 'aborted'})`
    : `reviewer call failed at the transport/provider layer (${o.reason ?? 'unknown error'})`;

/**
 * Pick the deliverable to carry into the next round from a producer revision.
 * An empty body, an abort, or a provider error retains the previous deliverable
 * rather than overwriting it with nothing (Track B FR-2). Pure so both adapters
 * share one guarded decision.
 */
export const applyRevision = (
  current: string,
  outcome: CompletionOutcome,
): { deliverable: string; retained: boolean } => {
  if (outcome.kind === 'body' && outcome.text.trim()) {
    return { deliverable: outcome.text.trim(), retained: false };
  }
  return { deliverable: current, retained: true };
};

/** Thrown when a model id cannot be resolved to a full registered model. */
export class ModelNotFoundError extends Error {
  readonly provider: string;
  readonly id: string;
  constructor(provider: string, id: string) {
    super(`Model not found in registry: ${provider}/${id}`);
    this.name = 'ModelNotFoundError';
    this.provider = provider;
    this.id = id;
  }
}

/**
 * Resolve a bare {provider,id} to the FULL registered model. Some runtimes'
 * completion APIs need the full model (baseUrl/api/compat/config), not a
 * stripped object; passing a stripped {provider,id} historically produced an
 * empty assistant.
 *
 * Throws ModelNotFoundError on a miss rather than silently falling back to the
 * stripped object, so the broken state can never silently degrade.
 */
export const resolveFullModel = <M extends { provider: string; id: string }>(
  registry: {
    find(provider: string, id: string): M | undefined;
    getAvailable(): M[];
  },
  model: { provider: string; id: string },
): M => {
  const found =
    registry.find(model.provider, model.id) ??
    registry.getAvailable().find((m) => m.id === model.id && m.provider === model.provider);
  if (!found) {
    throw new ModelNotFoundError(model.provider, model.id);
  }
  return found;
};

/**
 * Resolve a reviewer-model query against the available model list. Accepts
 * `provider/id`, or a bare `id`. Falls back by stripping common cloud-suffix
 * variants (`:cloud`, `-cloud`, `_cloud`, and `:cloud` with anything after).
 *
 * Multiple providers can serve the same model id (e.g. `opencode-go/glm-5.1`
 * and `ollama-cloud/glm-5.1`). When the query carries a cloud suffix hint, or
 * the matched id only exists under a cloud provider, prefer providers whose
 * name contains "cloud" before falling back to any other provider - so a
 * bare `glm-5.1:cloud` picks the reachable cloud endpoint, not the first
 * alphabetically. Returns undefined when nothing matches.
 */
export const resolveModel = (
  models: Array<{ provider: string; id: string }>,
  query: string,
): { provider: string; id: string } | undefined => {
  const slash = query.lastIndexOf('/');
  const provider = slash > 0 ? query.slice(0, slash) : undefined;
  const id = slash > 0 ? query.slice(slash + 1) : query;

  const cloudHint = /[:_-]cloud.*$/i.test(id);
  const candidates = [id, id.replace(/[:_-]cloud.*$/i, ''), id.replace(/:cloud$/i, '')];

  // Cloud-suffixed queries prefer cloud-named providers; otherwise (or if
  // that set is empty) fall back to all providers.
  const pool = (idToMatch: string) => {
    const preferCloud = cloudHint || /cloud/i.test(String(provider ?? ''));
    if (!preferCloud) return models.filter((m) => m.id === idToMatch);
    const cloud = models.filter((m) => /cloud/i.test(m.provider) && m.id === idToMatch);
    if (cloud.length) return cloud;
    return models.filter((m) => m.id === idToMatch);
  };

  for (const c of candidates) {
    const hit = pool(c).find((m) => (provider ? m.provider === provider : true));
    if (hit) return hit;
  }
  return undefined;
};

// Severity markers: emoji primary, textual labels as fallback so a reviewer
// that ignores the emoji contract is still understood. Matched on finding
// lines (bullets OR severity-prefixed headings like `🔴 High - ...`), so a
// heading-style reviewer is counted while severity words in prose are not.
const HIGH_RE =
  /(?:🔴|\[high\]|high\s*priority|severity\s*[:=]\s*high|\*\*high\*\*|^[-*]\s*high[:\s]|^high\s*[—–:-])/i;
const MEDIUM_RE =
  /(?:🟡|\[medium\]|medium\s*priority|severity\s*[:=]\s*medium|\*\*medium\*\*|^[-*]\s*medium[:\s]|^medium\s*[—–:-])/i;

/** A line that is a candidate finding: a bullet, a severity-tagged heading,
 *  or a bold-marker severity line (`**🔴 High - ...**`). */
const isFindingLine = (t: string): boolean =>
  /^\s*[-*]\s/.test(t) ||
  /^(?:\d+[.):]|\s*[•-])\s/.test(t) ||
  /\*{1,2}\s*🟢|\*{1,2}\s*🟡|\*{1,2}\s*🔴/.test(t) ||
  /^#{1,6}\s*🟢|^#{1,6}\s*🟡|^#{1,6}\s*🔴/.test(t) ||
  /^#{1,6}\s*(?:[Cc]ondition|[Ff]inding|[Ii]ssue|[Rr]eview)\b/.test(t) ||
  // Emoji BEFORE the bold marker (`🔴 **High — X.**`), the shape round 3
  // emitted (Track A FR-3 differential: this form scored 0/0 against real
  // findings). Previously missed because the only emoji-before-asterisks
  // pattern required the emoji INSIDE the bold.
  /^\s*[🟢🟡🔴]/u.test(t) ||
  // Inline severity prose at line start (`High — ...`) - the round-1 live
  // body wrote findings with no bullet and no emoji. Requires the severity
  // word followed by a dash/colon so sentences in prose are not counted.
  /^(?:high|medium|low)\s*[—–:-]/i.test(t);

/** A bold numbered-item line like `**H1. ...**` / `**M2. ...**` - how B
 *  lists individual findings under a `### 🔴 High` section heading. These carry
 *  no inline emoji, so they must be counted against the section's severity. */
const isBoldItemLine = (t: string): boolean => /^\*+[A-Za-z]\d+[.:]\s/.test(t);

/** Severity declared by a heading line, else null. A heading is treated as a
 *  *section container* only when it carries the severity tag with no
 *  descriptive title afterward - e.g. `### 🔴 High` (B's round 2/3 format),
 *  whose findings are the bold items beneath it. A heading like
 *  `#### 🔴 High - one` has a title after the severity, so it is a single
 *  self-contained finding and must not be treated as a container. */
const sectionSeverity = (t: string): 'high' | 'medium' | 'low' | null => {
  if (!/^#{1,6}\s/.test(t)) return null;
  if (/-|–|:/.test(t)) return null; // has a title → individual finding, not a container
  if (/(?:🔴|high\b)/i.test(t)) return 'high';
  if (/(?:🟡|medium\b)/i.test(t)) return 'medium';
  if (/(?:🟢|low\b)/i.test(t)) return 'low';
  return null;
};

/**
 * Classify a reviewer report. isFormatFollowed is true when the report carries
 * recognizable severity markers (emoji or textual) OR an explicit AGREE line,
 * so a blank / freeform reply is not mistaken for "no findings". A finding is
 * a bullet-ish line; we only count bullet lines (leading - / * or a numbered /
 * marker line with a severity tag) to avoid matching severity words in prose.
 */
export const classifyReport = (text: string): Verdict => {
  const lines = text.split('\n');
  let high = 0;
  let medium = 0;
  let section: 'high' | 'medium' | 'low' | null = null;

  for (const raw of lines) {
    const t = raw.trim();
    const sev = sectionSeverity(t);
    if (sev) {
      // A pure container heading (`### 🔴 High`) sets the section; its bold
      // numbered items (`**H1.** …`) count under it, not the heading itself.
      section = sev;
      continue;
    }
    if (isBoldItemLine(t) && section) {
      if (section === 'high') high++;
      else if (section === 'medium') medium++;
      continue;
    }
    if (!isFindingLine(t)) continue;
    if (HIGH_RE.test(t) && !/not.*high|no high/i.test(t)) {
      high++;
    } else if (MEDIUM_RE.test(t)) {
      medium++;
    } else if (section === 'high') {
      high++; // untagged finding line inherits the open section's severity
    } else if (section === 'medium') {
      medium++;
    }
  }

  const agree = parseAgree(text);
  const isFormatFollowed = agree !== undefined || /🔴|🟡|🟢/.test(text) || high + medium > 0;
  // A review only counts as having a body if there is substantive content
  // beyond the AGREE line - prevents an empty/garbage review (e.g. just
  // "AGREE: yes") from being approved as a clean pass.
  const bodyText = text.replace(/AGREE:\s*(yes|no)\b/i, '').trim();
  const hasBody = bodyText.length >= 8;

  return { isAgreed: agree, high, medium, isFormatFollowed, hasBody };
};

/**
 * The convergence decision per the rubric: isConverged = agreed (explicitly, or
 * implied by 0 open High when the report has no AGREE line) AND 0 open High AND
 * <=1 open Medium. If the report didn't follow the format, we cannot verify -
 * refuse to declare convergence (safe default).
 */
export const convergenceFor = (
  v: Verdict,
): {
  isConverged: boolean;
  reason: string;
} => {
  if (!v.isFormatFollowed) {
    return {
      isConverged: false,
      reason: 'reviewer did not follow the output format - cannot verify agreement',
    };
  }
  if (!v.hasBody) {
    return {
      isConverged: false,
      reason: 'reviewer returned an empty or trivial review - not a real approval',
    };
  }
  const agrees = v.isAgreed ?? v.high === 0;
  const mediumOk = v.medium <= 1;
  if (agrees && v.high === 0 && mediumOk) {
    return {
      isConverged: true,
      reason: `${v.high} open High, ${v.medium} open Medium`,
    };
  }
  const reasonParts = [];
  if (!agrees) reasonParts.push('reviewer did not agree');
  if (v.high > 0) reasonParts.push(`${v.high} open High`);
  if (!mediumOk) reasonParts.push(`${v.medium} open Medium (>1)`);
  return {
    isConverged: false,
    reason: reasonParts.join(', ') || 'no findings but also no agreement signal',
  };
};
