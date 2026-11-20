// PS-8 pilot: deterministic synthetic helper that normalizes a fixture label. Pure, no I/O.
// Draft scope: trims surrounding ASCII spaces (U+0020 only) and returns '' for all-space input.
// ASCII A–Z lowercasing is intentionally NOT implemented yet; it is reserved for the repair attempt.
export function normalizeReviewLoopLabel(label: string): string {
  let start = 0;
  let end = label.length;
  while (start < end && label.charCodeAt(start) === 0x20) start++;
  while (end > start && label.charCodeAt(end - 1) === 0x20) end--;
  return label.slice(start, end);
}
