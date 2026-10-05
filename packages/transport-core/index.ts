/**
 * Copyright 2026 Geoff Ballard
 * SPDX-License-Identifier: Apache-2.0
 */

// Neutral transport core barrel. No quality/sanity imports - any adapter or
// core reuses this OpenAI-compatible transport + URL policy.
export { chatComplete, type ChatCompleteOpts } from './openai.ts';
export { isLoopbackHost, validateBaseURL } from './validate.ts';
