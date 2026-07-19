import { describe, expect, it } from 'vitest';
import { thinkingConfigFor, outputBudgetFor } from '../thinking-config.js';

describe('thinkingConfigFor', () => {
  it('uses thinkingLevel for 3.x models', () => {
    expect(thinkingConfigFor('gemini-3.5-flash', { level: 'low' })).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-3.1-flash-lite')).toEqual({ thinkingLevel: 'minimal' }); // default
  });

  it('uses thinkingBudget for 2.5 models', () => {
    expect(thinkingConfigFor('gemini-2.5-flash', { budget: 512 })).toEqual({ thinkingBudget: 512 });
    expect(thinkingConfigFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 }); // default: reasoning off
  });
});

describe('outputBudgetFor', () => {
  it('sizes the output budget for reasoning tokens + the visible answer', () => {
    // The truncation incident: 350 was too small; 800 answer + 700 reasoning headroom = 1500.
    expect(outputBudgetFor(800)).toBe(1500);
    expect(outputBudgetFor(300, 200)).toBe(500);
  });
});
