// PS-8 pilot: deterministic synthetic helper that normalizes a fixture label. Pure, no I/O.
// Trims surrounding ASCII spaces (U+0020 only), lowercases ASCII A–Z only (all other characters,
// including interior spaces, are preserved), and returns '' for all-space input.
export function normalizeReviewLoopLabel(label: string): string {
  let start = 0;
  let end = label.length;
  while (start < end && label.charCodeAt(start) === 0x20) start++;
  while (end > start && label.charCodeAt(end - 1) === 0x20) end--;
  let out = '';
  for (let i = start; i < end; i++) {
    const code = label.charCodeAt(i);
    out += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : label[i];
  }
  return out;
}
