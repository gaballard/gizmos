/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime self-check for the sanity-check core. Run: node src/self-check.ts
// Mirrors the battery previously embedded in pi-sanity-check/core.ts, kept here
// so the shared core is provably correct independent of any adapter.

import { strict as nodeAssert } from 'node:assert';

// Count asserts as they run so the printed total is measured, not hardcoded:
// an assert added but never executed changes the total and fails loudly.
let assertsRun = 0;
const assert: typeof nodeAssert = ((...args: Parameters<typeof nodeAssert>) => {
  assertsRun++;
  return nodeAssert(...args);
}) as typeof nodeAssert;
import {
  applyRevision,
  blocksToText,
  classifyCompletion,
  classifyReport,
  classifyThrownCompletion,
  completionFailureReason,
  convergenceFor,
  extractLastAssistantText,
  ModelNotFoundError,
  parseAgree,
  resolveFullModel,
  resolveModel,
} from './index.ts';

assert(blocksToText('plain') === 'plain', 'blocksToText string');
assert(
  blocksToText([
    { type: 'text', text: 'a' },
    { type: 'text', text: 'b' },
  ]) === 'a\nb',
  'blocksToText join',
);
assert(blocksToText([{ type: 'image', text: 'x' }]) === '', 'blocksToText skips non-text');
// Reasoning-only reply (stopReason "length") must still yield text - not "" -
// or an empty revision would be fed to B as an empty deliverable next round.
assert(
  blocksToText([{ type: 'thinking', thinking: 'drafted revision' }]) === 'drafted revision',
  'blocksToText falls back to thinking-only blocks',
);
assert(
  blocksToText([
    { type: 'thinking', thinking: 't' },
    { type: 'text', text: 'real' },
  ]) === 'real',
  'blocksToText prefers text over thinking when both present',
);

assert(parseAgree('AGREE: yes') === true, 'parseAgree yes');
assert(parseAgree('AGREE: no') === false, 'parseAgree no');
assert(parseAgree('no agree line here') === undefined, 'parseAgree absent');

// Track A FR-1: verdict comes from the CLOSING AGREE line, not the first
// echo. Bodies quoting the template or a prior round's verdict mid-report
// must arrive at the trailing verdict.
assert(
  parseAgree('format says AGREE: <yes|no>. I disagree overall.\nAGREE: no') === false,
  'parseAgree echo-then-trailing-no',
);
assert(
  parseAgree('round 1 said AGREE: yes and I hold that.\nAGREE: no') === false,
  'parseAgree quoted-prior-round then trailing no',
);
assert(
  parseAgree('nothing concrete. AGREE: no is my verdict. AGREE: yes') === true,
  'parseAgree anchored to last',
);

// Track A FR-3: emoji BEFORE the bold marker, standalone (round 3's real
// shape). Scores 0/0 today - the differential fixture.
const emojiBold =
  '**Findings:**\n\n🔴 **High — Missing review target.**\n- Problem: no content.\n\n🟡 **Medium — No requirements given.**\nAGREE: no';
const vEmojiBold = classifyReport(emojiBold);
assert(vEmojiBold.high === 1, `emoji-before-bold high, got ${vEmojiBold.high}`);
assert(vEmojiBold.medium === 1, `emoji-before-bold medium, got ${vEmojiBold.medium}`);
assert(convergenceFor(vEmojiBold).isConverged === false, 'emoji-bold findings refuse converge');

// Track A FR-3: inline severity PROSE with no bullet and no emoji and no
// section context - the round-1 live body that scored false 0/0.
const prose =
  'Overall it holds up.\n' +
  'Medium — logging calls are inconsistent; use the shared logger.\n' +
  'High — rate limiter lacks a jitter window; retries can stampede.\n' +
  'AGREE: no';
const vProse = classifyReport(prose);
assert(vProse.high === 1, `prose high, got ${vProse.high}`);
assert(vProse.medium === 1, `prose medium, got ${vProse.medium}`);
assert(vProse.isFormatFollowed, 'prose isFormatFollowed');
assert(convergenceFor(vProse).isConverged === false, 'prose findings refuse converge');
// `**Summary:**` / `**Findings:**` prose headings must not count as findings.
const vHeadingsOnly = classifyReport('**Summary:** fine.\n**Findings:** none major.\nAGREE: yes');
assert(vHeadingsOnly.high === 0 && vHeadingsOnly.medium === 0, 'bold prose headings not counted');

// Format-following review → isConverged
const clean = 'Summary.\n- 🔴 High: X\n- 🟡 Medium: Y\n- 🔴 High: Z\nAGREE: no';
const vClean = classifyReport(clean);
assert(vClean.isFormatFollowed, 'clean isFormatFollowed');
assert(vClean.high === 2 && vClean.medium === 1, 'clean counts');
assert(convergenceFor(vClean).isConverged === false, 'clean not isConverged');

// Textual-only reviewer (no emoji) with zero findings → isConverged
const textOnly = 'Summary.\n1. High Priority: fixed.\nAGREE: yes';
const vText = classifyReport(textOnly);
assert(vText.isFormatFollowed, 'text-only isFormatFollowed');
assert(convergenceFor(vText).isConverged === false, 'text-only with 1 High not isConverged');

const textOnlyClean = 'AGREE: yes\n- Low Priority: nit';
const vTxtClean = classifyReport(textOnlyClean);
assert(vTxtClean.high === 0 && vTxtClean.medium === 0, 'text-only clean counts');
assert(convergenceFor(vTxtClean).isConverged === true, 'text-only clean isConverged');

// No-AGREE, no High → implied agree
const implicit = 'Summary.\n- 🟡 Medium: Y\n- 🟢 Low: nit.';
const vImplicit = classifyReport(implicit);
assert(vImplicit.isAgreed === undefined, 'implicit agree undefined');
assert(convergenceFor(vImplicit).isConverged === true, 'implicit agree via 0 High');

// Freeform report with no markers → NOT isConverged (refuse false pass, not "no findings")
const freeform = 'I looked at this and it seems okay in general, no strong opinions.';
const vFree = classifyReport(freeform);
assert(vFree.isFormatFollowed === false, 'freeform format not followed');
assert(convergenceFor(vFree).isConverged === false, 'freeform refused (no false convergence)');

// Empty/garbage body (AGREE line but no content) must NOT converge - this is
// the disease B surfaced: an empty review being rubber-stamped as a clean pass.
const agreeOnly = 'AGREE: yes';
const vAgreeOnly = classifyReport(agreeOnly);
assert(vAgreeOnly.isFormatFollowed === true, 'agree-only isFormatFollowed');
assert(vAgreeOnly.hasBody === false, 'agree-only has no body');
assert(
  convergenceFor(vAgreeOnly).isConverged === false,
  'agree-only must not converge (empty body)',
);

// A genuinely clean review WITH a body is a valid approval and must converge.
const cleanBody = 'This code is fine overall, no meaningful issues to report. AGREE: yes';
const vCleanBody = classifyReport(cleanBody);
assert(vCleanBody.hasBody === true, 'clean review has a body');
assert(convergenceFor(vCleanBody).isConverged === true, 'clean review with body converges');

// Real findings + AGREE:no must NOT converge (existing contract).
const realFindings = '**🔴 High - leak**\n**🟡 Medium - race**\nAGREE: no';
const vReal = classifyReport(realFindings);
assert(vReal.high === 1 && vReal.medium === 1, 'real findings counted');
assert(convergenceFor(vReal).isConverged === false, 'real findings not isConverged');

// Heading-style reviewer (B's real format: `#### 🔴 High - ...`) must count.
// This is the regression for the reported `0 High / 0 Medium` bug.
const headingStyle =
  '## Review\n' +
  '#### 🔴 High - one\n#### 🔴 High - two\n' +
  '#### 🟡 Medium - one\n#### 🟢 Low - one\n' +
  'AGREE: no';
const vHead = classifyReport(headingStyle);
assert(vHead.high === 2, `heading-style high count, got ${vHead.high}`);
assert(vHead.medium === 1, `heading-style medium count, got ${vHead.medium}`);
assert(vHead.isFormatFollowed, 'heading-style isFormatFollowed');

// Bold-marker severity lines (`**🔴 High - ...**`) must also count - this is
// the format B actually emitted, which caused the false `0 High/0 Medium`.
const boldStyle =
  '## Review\n' +
  '**🔴 High - one**\n**🔴 High - two**\n' +
  '**🟡 Medium - one**\n**🟢 Low - one**\n' +
  'AGREE: no';
const vBold = classifyReport(boldStyle);
assert(vBold.high === 2, `bold-style high count, got ${vBold.high}`);
assert(vBold.medium === 1, `bold-style medium count, got ${vBold.medium}`);
assert(vBold.isFormatFollowed, 'bold-style isFormatFollowed');

// Track B FR-1: a resolved provider error is a failure, not an empty body.
const errOutcome = classifyCompletion({
  stopReason: 'error',
  errorMessage: '400 {"type":"error","error":{"type":"MissingSessionID"}}',
  content: [],
});
assert(errOutcome.kind === 'provider-error', `provider error kind, got ${errOutcome.kind}`);
assert(errOutcome.text === '', 'provider error has no text');
assert(
  completionFailureReason(errOutcome).includes('transport'),
  'provider error reason names transport',
);
// An abort is its own kind.
assert(
  classifyCompletion({ stopReason: 'aborted', content: [] }).kind === 'aborted',
  'aborted kind',
);
assert(
  classifyThrownCompletion(new Error('This operation was aborted')).kind === 'aborted',
  'thrown abort classified as aborted',
);
// A normal stop is a body; an empty normal body is still a body (not an error).
const bodyOutcome = classifyCompletion({
  stopReason: 'end',
  content: [{ type: 'text', text: 'review text' }],
});
assert(bodyOutcome.kind === 'body' && bodyOutcome.text === 'review text', 'normal body text');
assert(
  classifyCompletion({ stopReason: 'end', content: [] }).kind === 'body',
  'empty normal stop is a body, not provider-error',
);

// Track B FR-2: an empty or failed revision must not overwrite the good deliverable.
const good = 'previous good deliverable';
assert(
  applyRevision(good, { kind: 'body', text: 'new deliverable' }).deliverable === 'new deliverable',
  'real revision replaces the deliverable',
);
const emptyRevision = applyRevision(good, { kind: 'body', text: '   ' });
assert(
  emptyRevision.retained === true && emptyRevision.deliverable === good,
  'empty revision retains the deliverable',
);
const failedRevision = applyRevision(good, {
  kind: 'provider-error',
  text: '',
  reason: '400 MissingSessionID',
});
assert(failedRevision.retained === true, 'provider-error revision retains the deliverable');
assert(
  applyRevision(good, { kind: 'aborted', text: '' }).deliverable === good,
  'aborted revision retains the deliverable',
);

// resolveFullModel: bare {provider,id} resolves to the full registered model.
interface FullModel {
  provider: string;
  id: string;
  baseUrl: string;
  api?: string;
}
const reg = {
  find: (p: string, i: string): FullModel | undefined =>
    p === 'ollama-cloud' && i === 'glm-5.1'
      ? {
          provider: 'ollama-cloud',
          id: 'glm-5.1',
          baseUrl: 'https://x',
          api: 'openai-completions',
        }
      : undefined,
  getAvailable: (): FullModel[] => [
    { provider: 'opencode-go', id: 'glm-5.1', baseUrl: 'u' },
    {
      provider: 'ollama-cloud',
      id: 'minimax-m3',
      baseUrl: 'https://y',
      api: 'openai-completions',
    },
  ],
};
assert(
  resolveFullModel(reg, { provider: 'ollama-cloud', id: 'minimax-m3' }).baseUrl === 'https://y',
  'resolveFullModel gets full model (not stripped)',
);
assert(
  resolveFullModel(reg, { provider: 'ollama-cloud', id: 'glm-5.1' }).baseUrl === 'https://x',
  'resolveFullModel via find',
);
let threw = false;
try {
  resolveFullModel(reg, { provider: 'olm-cloud', id: 'nope' });
} catch (e) {
  threw = e instanceof ModelNotFoundError;
}
assert(threw, 'resolveFullModel throws ModelNotFoundError on miss (no silent fallback)');

// Determinism
assert(
  JSON.stringify(classifyReport(clean)) === JSON.stringify(classifyReport(clean)),
  'classifyReport deterministic',
);

// resolveModel
const mods = [
  { provider: 'ollama-local', id: 'qwen-small' },
  { provider: 'ollama-cloud', id: 'glm-5.1' },
  { provider: 'ollama-cloud', id: 'qwen3.5' },
];
assert(
  resolveModel(mods, 'ollama-cloud/glm-5.1')?.id === 'glm-5.1',
  'resolveModel exact provider/id',
);
assert(resolveModel(mods, 'glm-5.1')?.provider === 'ollama-cloud', 'resolveModel bare id');
assert(
  resolveModel(mods, 'glm-5.1:cloud')?.provider === 'ollama-cloud' &&
    resolveModel(mods, 'glm-5.1:cloud')?.id === 'glm-5.1',
  'resolveModel strips :cloud suffix',
);

// Ambiguity: multiple providers serve the same id. The :cloud hint must
// prefer the cloud-named provider even when another comes first in the list.
const ambiguous = [
  { provider: 'opencode-go', id: 'glm-5.1' },
  { provider: 'ollama-cloud', id: 'glm-5.1' },
];
assert(
  resolveModel(ambiguous, 'glm-5.1')?.provider === 'opencode-go',
  'resolveModel bare id picks first provider',
);
assert(
  resolveModel(ambiguous, 'glm-5.1:cloud')?.provider === 'ollama-cloud',
  'resolveModel cloud hint prefers cloud provider over earlier non-cloud',
);
assert(
  resolveModel(ambiguous, 'ollama-cloud/glm-5.1')?.provider === 'ollama-cloud',
  'resolveModel explicit cloud provider wins',
);
assert(
  resolveModel(mods, 'ollama-cloud/glm-5.1:cloud')?.id === 'glm-5.1',
  'resolveModel strips suffix with provider',
);
assert(resolveModel(mods, 'glm-5.1-cloud')?.id === 'glm-5.1', 'resolveModel -cloud suffix');
assert(resolveModel(mods, 'nonexistent') === undefined, 'resolveModel no match');

// extractLastAssistantText: direct {role, content} shape
assert(
  extractLastAssistantText([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer A' }] },
  ]) === 'answer A',
  'extractLastAssistantText direct shape',
);
// wrapped {message:{...}} shape
assert(
  extractLastAssistantText([
    {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'wrapped' }],
      },
    },
  ]) === 'wrapped',
  'extractLastAssistantText wrapped shape',
);
// picks the newest assistant message, ignoring later non-assistant entries
assert(
  extractLastAssistantText([
    { role: 'assistant', content: [{ type: 'text', text: 'older' }] },
    { role: 'user', content: [{ type: 'text', text: 'later user' }] },
  ]) === 'older',
  'extractLastAssistantText skips user',
);
// empty content / no assistant → empty string
assert(extractLastAssistantText([]) === '', 'extractLastAssistantText empty');
assert(
  extractLastAssistantText([{ role: 'assistant', content: [] }]) === '',
  'extractLastAssistantText blank content',
);

// Count is measured by the wrapping `assert` above, not hardcoded: an assert
// added but never executed changes the measured total and fails loudly.
console.log(`sanity-check core self-check ok (assert calls: ${assertsRun})`);
