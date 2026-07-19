// Model-family-specific "thinking" (reasoning) control for Gemini, plus the incident that made
// it load-bearing.
//
// Gemini exposes reasoning differently across families (verified against the live v1beta API):
//   Gemini 3.x  ->  generationConfig.thinkingConfig.thinkingLevel  ('minimal' | 'low' | 'medium' | 'high')
//   Gemini 2.5  ->  generationConfig.thinkingConfig.thinkingBudget (integer token budget)
//
// THE TRUNCATION INCIDENT — why the OUTPUT budget matters here:
// On the 3.x models, thinking tokens are drawn from the SAME `maxOutputTokens` budget as the
// visible answer. With `maxOutputTokens` capped at 350, ~330-600 thinking tokens ate almost the
// whole budget and the visible answer clipped mid-sentence (`finishReason: MAX_TOKENS`). It read
// like the reasoning level misbehaving; it was a budget-too-small bug. Raising the cap 350 -> 1500
// left room for BOTH the reasoning and the full answer, and both finished at `STOP`.
// Baked-in lesson: when reasoning is on, size `maxOutputTokens` for reasoning tokens + answer,
// not just the answer. `outputBudgetFor()` below does that for you.
//
// camelCase keys (`thinkingLevel` / `thinkingBudget`) are correct — the v1beta REST JSON honors
// them, same as `generationConfig` itself.

/**
 * Build the family-appropriate `thinkingConfig` fragment for a model.
 * @param {string} model  e.g. `'gemini-3.5-flash'` or `'gemini-2.5-flash'`
 * @param {object} [o]
 * @param {'minimal'|'low'|'medium'|'high'} [o.level='minimal']  reasoning level for 3.x models
 * @param {number} [o.budget=0]  reasoning token budget for 2.5 models (0 = reasoning off)
 * @returns {{ thinkingLevel: string } | { thinkingBudget: number }}
 */
export function thinkingConfigFor(model, { level = 'minimal', budget = 0 } = {}) {
  if (String(model).startsWith('gemini-2.5')) return { thinkingBudget: budget };
  return { thinkingLevel: level };
}

/**
 * Size `maxOutputTokens` for reasoning tokens + the visible answer, so a reasoning-on call never
 * truncates the answer (see the truncation incident above).
 * @param {number} answerTokens        room you want for the visible answer
 * @param {number} [reasoningHeadroom=700]  expected reasoning tokens on top of that
 * @returns {number}
 */
export function outputBudgetFor(answerTokens, reasoningHeadroom = 700) {
  return answerTokens + reasoningHeadroom;
}
