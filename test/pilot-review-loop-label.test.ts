import { describe, expect, it } from 'vitest';
import { normalizeReviewLoopLabel } from '../server/pilot/review-loop-label.ts';

describe('normalizeReviewLoopLabel (PS-8 pilot)', () => {
  it('trims surrounding ASCII spaces', () => {
    expect(normalizeReviewLoopLabel('   fixture   ')).toBe('fixture');
  });

  it('preserves interior spaces', () => {
    expect(normalizeReviewLoopLabel('  fixture  label  ')).toBe('fixture  label');
  });

  it('returns the empty string for an all-space input', () => {
    expect(normalizeReviewLoopLabel('     ')).toBe('');
    expect(normalizeReviewLoopLabel('')).toBe('');
  });
});
