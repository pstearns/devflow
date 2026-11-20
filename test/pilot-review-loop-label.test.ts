import { describe, expect, it } from 'vitest';
import { normalizeReviewLoopLabel } from '../server/pilot/review-loop-label.ts';

describe('normalizeReviewLoopLabel (PS-8 pilot)', () => {
  it('trims surrounding ASCII spaces', () => {
    expect(normalizeReviewLoopLabel('   fixture   ')).toBe('fixture');
  });

  it('preserves interior spaces', () => {
    expect(normalizeReviewLoopLabel('  fixture  label  ')).toBe('fixture  label');
  });

  it('lowercases ASCII A-Z while preserving interior spaces', () => {
    expect(normalizeReviewLoopLabel('  Fixture  LABEL  ')).toBe('fixture  label');
    expect(normalizeReviewLoopLabel('ABC xyz 123-_')).toBe('abc xyz 123-_');
  });

  it('leaves non-ASCII letters unchanged', () => {
    expect(normalizeReviewLoopLabel(' ÀÉ Straße ')).toBe('ÀÉ straße');
  });

  it('returns the empty string for an all-space input', () => {
    expect(normalizeReviewLoopLabel('     ')).toBe('');
    expect(normalizeReviewLoopLabel('')).toBe('');
  });
});
