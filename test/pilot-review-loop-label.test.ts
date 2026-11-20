import { describe, expect, it } from 'vitest';
import { normalizeReviewLoopLabel } from '../server/pilot/review-loop-label.ts';

describe('normalizeReviewLoopLabel (PS-8 pilot)', () => {
  it('trims surrounding ASCII spaces', () => {
    expect(normalizeReviewLoopLabel('   ready  ')).toBe('ready');
  });

  it('returns the empty string for an all-space input', () => {
    expect(normalizeReviewLoopLabel('     ')).toBe('');
    expect(normalizeReviewLoopLabel('')).toBe('');
  });

  it('lowercases ASCII A-Z while preserving interior spaces', () => {
    expect(normalizeReviewLoopLabel('  ReAdY  NOW  ')).toBe('ready  now');
    expect(normalizeReviewLoopLabel('AZ az 09')).toBe('az az 09');
  });

  it('leaves non-ASCII letters unchanged', () => {
    expect(normalizeReviewLoopLabel(' ÄÉ ')).toBe('ÄÉ');
  });
});
