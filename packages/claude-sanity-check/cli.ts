#!/usr/bin/env node

/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MAX_ROUNDS,
  PRODUCER_SYSTEM,
  REVIEWER_SYSTEM,
  applyRevision,
  chatComplete,
  classifyReport,
  classifyThrownCompletion,
  completionFailureReason,
  convergenceFor,
  frameDeliverable,
  parseAgree,
  type CompletionOutcome,
} from '@gizmos/sanity-check-core';
import { readFileSync } from 'node:fs';

/**
 * `sanity-check` CLI - the Claude Code counterpart of the pi extension's
 * `/sanity-check` A/B agree/disagree loop. The slash command shells out here.
 *
 *   sanity-check <deliverable-path>
 *
 * The loop lives in this script (not in Claude's session) and calls BOTH the
 * producer and the reviewer as OpenAI-compatible completions (see
 * sanity-check-core `chatComplete`), per the adapter's chosen config:
 *
 *   SANITY_CHECK_BASE_URL   OpenAI-compatible host (default http://localhost:1234/v1)
 *   SANITY_CHECK_A_MODEL    producer / reviser model (default claude-sonnet-4-20250514)
 *   SANITY_CHECK_B_MODEL    independent reviewer model (default qwen3.8-4b-distill)
 *
 * Verdict logic (convergence, empty-review refusal) comes from
 * sanity-check-core. Prints the running transcript to stdout (Claude reads it
 * back) and exits 0 on convergence, 1 when the cap is hit unresolved.
 */

const BASE_URL = process.env.SANITY_CHECK_BASE_URL ?? 'http://localhost:1234/v1';
const PRODUCER_MODEL = process.env.SANITY_CHECK_A_MODEL ?? 'claude-sonnet-4-20250514';
const REVIEWER_MODEL = process.env.SANITY_CHECK_B_MODEL ?? 'qwen3.8-4b-distill';

/** Output-token budget for review/revise calls: SANITY_CHECK_MAX_TOKENS env >
 *  the 4000 default. (The pi adapter adds a persisted-state tier and a
 *  /sanity-checker flag; the CLI stays env-driven like its other knobs.) */
const maxTokensBudget = (): number => {
  const n = Number(process.env.SANITY_CHECK_MAX_TOKENS);
  if (Number.isFinite(n) && n > 0) return n;
  return 4000;
};

/** Ask the B (reviewer) model to critique the current deliverable. A thrown
 *  transport error is classified, not collapsed into an empty string. */
const review = async (deliverable: string): Promise<CompletionOutcome> => {
  try {
    return {
      kind: 'body',
      text: await chatComplete({
        baseURL: BASE_URL,
        model: REVIEWER_MODEL,
        system: REVIEWER_SYSTEM,
        user: frameDeliverable(deliverable),
        maxTokens: maxTokensBudget(),
      }),
    };
  } catch (err) {
    return classifyThrownCompletion(err);
  }
};

/** Ask the A (producer) model to revise the deliverable in light of the reviewer's findings. */
const revise = async (deliverable: string, reviewText: string): Promise<CompletionOutcome> => {
  try {
    return {
      kind: 'body',
      text: await chatComplete({
        baseURL: BASE_URL,
        model: PRODUCER_MODEL,
        system: PRODUCER_SYSTEM,
        user: `Original deliverable:\n\n${deliverable}\n\nReviewer's findings:\n\n${reviewText}`,
        maxTokens: maxTokensBudget(),
      }),
    };
  } catch (err) {
    return classifyThrownCompletion(err);
  }
};

export const main = async (args: string[]): Promise<number> => {
  // Documented divergence (FR-4): the pi adapter routes a configured thinking
  // level through streamSimple; this CLI's transport is the plain
  // OpenAI-compatible chatComplete, which has no thinking field - say so
  // instead of silently ignoring the knob.
  if (process.env.SANITY_CHECK_THINKING) {
    console.warn(
      'warning: SANITY_CHECK_THINKING is set; the CLI transport is plain OpenAI-compatible - thinking level is not applied here (budget: SANITY_CHECK_MAX_TOKENS)',
    );
  }
  const pathArg = args[0];
  if (!pathArg) {
    console.error('usage: sanity-check <deliverable-path>');
    return 2;
  }

  let deliverable: string;
  try {
    deliverable = readFileSync(pathArg, 'utf8');
  } catch (err) {
    console.error('Cannot read deliverable: %s: %s', pathArg, (err as Error).message);
    return 2;
  }
  if (!deliverable.trim()) {
    console.error('deliverable is empty');
    return 2;
  }

  if (PRODUCER_MODEL === REVIEWER_MODEL) {
    console.warn(
      'warning: producer model equals reviewer model (%s) - not an independent review',
      REVIEWER_MODEL,
    );
  }
  console.log(
    `Sanity Check: producer A=${PRODUCER_MODEL}  reviewer B=${REVIEWER_MODEL}  (${MAX_ROUNDS} rounds max)`,
  );

  let current = deliverable;
  let round = 1;
  let reviewedRounds = 0;
  let voidedRounds = 0;
  while (round <= MAX_ROUNDS) {
    console.log(`\nRound ${round}/${MAX_ROUNDS}: reviewer ${REVIEWER_MODEL} analyzing…`);
    const reviewOutcome = await review(current);

    // FR-1/FR-3: a provider/transport failure is not a review.
    if (reviewOutcome.kind !== 'body') {
      voidedRounds++;
      console.error(
        `\n[Round ${round}] ${REVIEWER_MODEL} review FAILED: ${completionFailureReason(reviewOutcome)}`,
      );
      console.error(
        reviewedRounds === 0
          ? 'No rounds completed - every review call failed at the transport/provider layer.'
          : `Voided rounds: ${voidedRounds} of ${reviewedRounds + voidedRounds} review attempt(s) failed at the transport/provider layer.`,
      );
      console.error(
        'Not converged - surface the residual disputes to the user; do not claim agreement.',
      );
      return 1;
    }

    const reviewText = reviewOutcome.text;
    reviewedRounds++;
    const v = classifyReport(reviewText);
    const isAgreed = parseAgree(reviewText);
    console.log(
      `[Round ${round}] ${REVIEWER_MODEL} review (agree=${String(isAgreed)}, ` +
        `${v.high} High / ${v.medium} Medium):\n\n${reviewText || '(empty review)'}`,
    );

    const verdict = convergenceFor(v);
    if (verdict.isConverged) {
      console.log(`\nCONVERGED at round ${round}: ${verdict.reason}`);
      return 0;
    }
    if (round === MAX_ROUNDS) {
      console.log(`\nSTOPPED at round ${round} (cap ${MAX_ROUNDS}): ${verdict.reason}`);
      if (voidedRounds > 0) {
        console.log(
          `Voided rounds: ${voidedRounds} of ${reviewedRounds + voidedRounds} review attempt(s) failed at the transport/provider layer.`,
        );
      }
      console.log(
        'Not converged - surface the residual disputes to the user; do not claim agreement.',
      );
      return 1;
    }

    console.log(
      `Round ${round}: producer ${PRODUCER_MODEL} revising in response to reviewer (${verdict.reason})…`,
    );
    const revisedOutcome = await revise(current, reviewText);
    // Never feed B an empty revision: retain the last good deliverable if the
    // producer came back blank (reasoning-mode truncation, endpoint hiccup).
    const revision = applyRevision(current, revisedOutcome);
    current = revision.deliverable;
    if (revision.retained) {
      console.warn(
        revisedOutcome.kind === 'body'
          ? 'producer returned an empty revision - retaining previous deliverable'
          : `producer revision failed (${revisedOutcome.kind}) - retaining previous deliverable`,
      );
    }
    round++;
  }
  return 1;
};

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
