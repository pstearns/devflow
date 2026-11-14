# M1 live-agent runs (synthetic, disposable fixtures)

> Runs A–D were made at commit `1236ef0`. After the independent Codex review (see PR description) seven defects were fixed in later commits; the real-CLI smoke run E below was repeated on the fixed code.

Real Claude Code and real Codex, each inside the bubblewrap sandbox with a copy of the owner's own login. Nothing about the agents' answers was
scripted. Everything around them was local and synthetic: a temp bare repo as `origin`, the synthetic Linear, an in-memory draft-PR service, and a
CI that really ran `node --test` on each pushed SHA. No real Linear, GitHub, or production project was touched.
Script: `scripts/m1-live.ts` (opt-in, spends model tokens). Full evidence for each run is retained **outside the repository**
(`~/.local/share/devflow/m1-evidence/ATL-22-<runId>/`: manifest, events, per-attempt prompts/outputs/CI/review/patch, audit trail).

Agents: Claude Code 2.1.316, Codex 0.169.0-alpha.11.1 (the build bundled with the VS Code extension; see REFERENCE for the explicit-path requirement).

## Run D — the requested demonstration: FAIL → repair → FAIL → repair → PASS (fixture `rounding2`)

Run `mwegha7jc8f890`, branch `devflow/atl-22-mwegha7jc8f890`, base `main` @ `50aef42ee9450eaeea28b6e8912a08cc99f1cc93`, draft PR #7 (synthetic).

| Attempt | Commit (parent) | CI on that SHA | Codex | Finding (Codex, evidence-backed) |
|---|---|---|---|---|
| initial | `943e52b6d1e4` (`50aef42ee945`) | success | **FAIL** | `mills += qty * Math.round(unitPrice * 1000)` loses precision above 2^53: `[{1,1e13},{1,0.005},{-1,1e13}]` returned 0, must be 0.01 |
| repair 1 | `01475cf424dc` (`943e52b6d1e4`) | success | **FAIL** | `BigInt(n)` vs `String(n)` mismatch on large integer prices: `invoiceTotal([{qty:n,unitPrice:1},{qty:-1,unitPrice:n}])` returned 28 instead of 0 |
| repair 2 | `375537a9a50e` (`01475cf424dc`) | success | **PASS** | none; `approvedSha` = `375537a9a50e0ca3a85d5cf8c3b8ab440d910e61` |

Controller gate on the approved SHA (all ✅): review is for this SHA · CI green on this SHA · remote branch at this SHA · draft PR head at this SHA ·
all changed files attested · trusted policy intact. Ticket ended in `In Review`; run state `awaiting-owner`; clone removed after PASS; no merge; no
infrastructure retries; policy digest `476888b0…`.

Resource usage (as reported by the CLIs): wall clock 265 s; Claude 197.5 s API time, ~645k tokens including cache, $0.798 (CLI-reported);
Codex ~62k tokens; 3 CI runs; 11 Linear comments; run directory 292 KB.

## Other real runs from the same session (for honesty about what the agents do)

| Run | Fixture | Result | Claude (CLI-reported) | Codex tokens | Wall |
|---|---|---|---|---|---|
| A | `rounding` (unbounded floats) | Codex FAILed all 4 commits (each time a deeper float-precision defect the spec could not make exact); Claude used 3 repairs; **escalated** (`repairs-exhausted`), ticket → Blocked, 14 comments | $0.856 | ~79.7k | 282 s |
| B | `cents` (helper doc/code mismatch) | Claude noticed the mismatch and fixed it itself; **PASS on first commit** | $0.235 | ~4.2k | 76 s |
| C | `invoice2` (several subtle rules) | **PASS on first commit** | $0.285 | ~21.3k | 82 s |
| D | `rounding2` | **FAIL → repair → FAIL → repair → PASS** (above) | $0.798 | ~62.4k | 265 s |

| E | `cents`, re-run on the post-review code | Claude refused to run: the account had hit its **5-hour usage limit** (`terminal_reason: api_error`). The controller classified it `infrastructure`, retried 3×, consumed **no repair**, moved the ticket to Blocked and kept evidence. A real-world confirmation of the infra path; the post-fix real-CLI success run could not be repeated until the limit resets | $0.084 | – | 10 s |

Fixtures B and C did not produce a FAIL: the implementer was simply good enough. D was the third fixture designed to make a defect objectively present
and objectively fixable. Run A shows the escalation path with real agents.

## Linear audit trail for run D (11 comments on the one ticket; excerpts)

1. **Milestone 1/6 — Execution authorized and started** — who authorized (from Linear history), approved scope, repo/base SHA, agent identities and versions, policy digest, limits, run record.
2. **Milestone 2/6 — Implementation completed** — commit, parent, PR, controller checks, Claude exit status.
3. **Milestone 3/6 — CI verified** — per-check result for that SHA.
4. **Milestone 4/6 — Independent review completed** — verdict, controller verification row, quoted agent findings, and **Milestone 5/6 — Repair requested** (repair 1 of 3, reason, retry counters).
5. **Milestone 2/6 — Repair 1 completed** … and so on per attempt …
11. **Milestone 6/6 — Awaiting owner approval** — gate row, branch/PR/base, repair and retry counters, retained-evidence references, **owner action required**, and the attempt table:

```
| Attempt  | Commit        | CI      | Review | Outcome                       |
| initial  | 943e52b6d1e4  | success | FAIL   | Review FAIL with 1 finding(s) |
| repair 1 | 01475cf424dc  | success | FAIL   | Review FAIL with 1 finding(s) |
| repair 2 | 375537a9a50e  | success | PASS   | accepted                      |
```

The full ordered trail is `audit-trail.md` in the retained evidence directory. Comments contain no host paths, environment, or credentials; evidence
is referenced relative to the runs directory.
