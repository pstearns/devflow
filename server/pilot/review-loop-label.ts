// PS-8 pilot: deterministic synthetic helper that normalizes a fixture label. Pure, no I/O.
// Trims surrounding ASCII spaces (U+0020 only), lowercases ASCII A–Z only (other characters,
// including non-ASCII letters, are left unchanged), preserves interior spaces and returns ''
// for an all-space input.
export function normalizeReviewLoopLabel(label: string): string {
  let start = 0;
  let end = label.length;
  while (start < end && label.charCodeAt(start) === 0x20) start++;
  while (end > start && label.charCodeAt(end - 1) === 0x20) end--;
  return label.slice(start, end).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x20));
}
