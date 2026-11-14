// The reviewer's answer is untrusted text. This is the ONLY gate between it and Linear: strict shape, exact commit,
// per-invocation nonce, and a PASS has to account for every file the commit changed. A bare {"verdict":"PASS"} fails.
import type { Finding, Review, Severity } from './types.ts';
import { isObj } from '../util.ts';

export class ReviewInvalid extends Error {}

export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'commit', 'nonce', 'summary', 'reviewed_files', 'findings'],
  properties: {
    verdict: { enum: ['PASS', 'FAIL'] }, commit: { type: 'string' }, nonce: { type: 'string' }, summary: { type: 'string' },
    reviewed_files: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'severity', 'file', 'line', 'title', 'detail', 'evidence'],
      properties: { id: { type: 'string' }, severity: { enum: ['blocker', 'major', 'minor', 'note'] }, file: { type: 'string' }, line: { type: ['integer', 'null'] }, title: { type: 'string' }, detail: { type: 'string' }, evidence: { type: 'string' } } } },
  },
};

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'note'];
const SHA_RE = /^[0-9a-f]{40}$/;
const blocking = (f: Finding) => f.severity === 'blocker' || f.severity === 'major';

export interface ReviewContext {
  sha: string; nonce: string;
  changedFiles: string[]; // from the controller's own `git diff --name-only base..sha`
  /** Line count of a file in the reviewed tree, or undefined when the file is not in the commit. */
  lineCount: (file: string) => number | undefined;
}

function text(v: unknown, what: string, max: number, required = true): string {
  if (typeof v !== 'string' || (required && !v.trim())) throw new ReviewInvalid(`${what} must be a non-empty string`);
  if (v.length > max) throw new ReviewInvalid(`${what} is longer than ${max} characters`);
  return v;
}
function exact(o: Record<string, unknown>, keys: string[], what: string) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in o));
  if (extra.length || missing.length) throw new ReviewInvalid(`${what}: ${extra.length ? `unexpected field "${extra[0]}"` : `missing field "${missing[0]}"`}`);
}

/** Extracts the single JSON object the reviewer printed. Anything but one object (prose, two objects, fences) is rejected. */
export function parseReviewOutput(stdout: string): unknown {
  const t = stdout.trim();
  try { return JSON.parse(t); } catch { throw new ReviewInvalid('reviewer output is not a single JSON object'); }
}

export function validateReview(raw: unknown, ctx: ReviewContext): Review {
  if (!isObj(raw)) throw new ReviewInvalid('review must be a JSON object');
  exact(raw, ['verdict', 'commit', 'nonce', 'summary', 'reviewed_files', 'findings'], 'review');
  if (raw.verdict !== 'PASS' && raw.verdict !== 'FAIL') throw new ReviewInvalid('verdict must be exactly PASS or FAIL');
  const commit = text(raw.commit, 'commit', 64).toLowerCase();
  if (!SHA_RE.test(commit)) throw new ReviewInvalid('commit must be a full 40-character SHA');
  if (commit !== ctx.sha) throw new ReviewInvalid(`review is for ${commit.slice(0, 12)} but the commit under review is ${ctx.sha.slice(0, 12)} (stale or wrong commit)`);
  if (raw.nonce !== ctx.nonce) throw new ReviewInvalid('review nonce does not match this review invocation (replayed or fabricated)');
  const summary = text(raw.summary, 'summary', 4000);
  if (!Array.isArray(raw.reviewed_files) || raw.reviewed_files.length > 2000) throw new ReviewInvalid('reviewed_files must be an array');
  const reviewedFiles = raw.reviewed_files.map((f) => text(f, 'reviewed_files[]', 500));
  if (!Array.isArray(raw.findings) || raw.findings.length > 100) throw new ReviewInvalid('findings must be an array of at most 100');
  const seen = new Set<string>();
  const findings = raw.findings.map((f, n): Finding => {
    const at = `findings[${n}]`;
    if (!isObj(f)) throw new ReviewInvalid(`${at} must be an object`);
    exact(f, ['id', 'severity', 'file', 'line', 'title', 'detail', 'evidence'], at);
    const id = text(f.id, `${at}.id`, 40);
    if (seen.has(id)) throw new ReviewInvalid(`${at}.id "${id}" is duplicated`);
    seen.add(id);
    if (!SEVERITIES.includes(f.severity as Severity)) throw new ReviewInvalid(`${at}.severity must be one of ${SEVERITIES.join(', ')}`);
    const file = text(f.file, `${at}.file`, 500);
    const lines = ctx.lineCount(file);
    if (lines === undefined) throw new ReviewInvalid(`${at}.file "${file.slice(0, 100)}" does not exist in the reviewed commit`);
    let line: number | undefined;
    if (f.line !== null && f.line !== undefined) {
      if (!Number.isInteger(f.line) || (f.line as number) < 1 || (f.line as number) > Math.max(1, lines)) throw new ReviewInvalid(`${at}.line is outside ${file}`);
      line = f.line as number;
    }
    return { id, severity: f.severity as Severity, file, line, title: text(f.title, `${at}.title`, 300), detail: text(f.detail, `${at}.detail`, 3000), evidence: text(f.evidence, `${at}.evidence`, 3000, blocking({ severity: f.severity } as Finding)) };
  });
  const hasBlocking = findings.some(blocking);
  if (raw.verdict === 'FAIL' && !hasBlocking) throw new ReviewInvalid('FAIL requires at least one blocker or major finding with evidence');
  if (raw.verdict === 'PASS') {
    if (hasBlocking) throw new ReviewInvalid('PASS cannot carry blocker or major findings');
    const reviewed = new Set(reviewedFiles);
    const missed = ctx.changedFiles.filter((f) => !reviewed.has(f));
    if (!ctx.changedFiles.length) throw new ReviewInvalid('the commit changes no files, so there is nothing a PASS could attest to');
    if (missed.length) throw new ReviewInvalid(`PASS does not account for changed file(s): ${missed.slice(0, 5).join(', ')}`);
  }
  return { verdict: raw.verdict, commit, nonce: ctx.nonce, summary, reviewedFiles, findings };
}
