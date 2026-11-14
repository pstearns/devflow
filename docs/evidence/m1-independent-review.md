# M1 independent Codex review: six rounds

Reviewer: real Codex (`codex-cli 0.169.0-alpha.11.1`, ChatGPT login) inside DevFlow's own read-only sandbox, against an exported snapshot of the commit under
review plus the full diff and a threat-model brief. Read-only, no write access, no repository access beyond the snapshot. Each round was told what the
previous round found and asked to defeat the fixes first, then look for new defects. Every finding below was checked against the code and had a regression
test added before it was closed. Rounds 1–6 reviewed commits `1236ef0`, `f422095`, `9a2e9fa`, `b5493d5`, `d65a9c6`, `9422cdc` (the last finding was fixed in the commit that follows it).

| Round | Findings | Highest | What they were |
|---|---|---|---|
| 1 | 7 | High | credential write-back followed agent-planted symlinks; Node prefix mount unvalidated; CLI used the first project of the team; policy not re-verified inside retries; filename markdown injection; existing PR reused without draft/base checks; first attempt skipped the repair budget |
| 2 | 5 | High | system mounts and symlinked credential dirs not compared canonically; comment retry bypassed the pin; approval used stale ticket authority; lone `\r` and reference links escaped quoting; host paths in escalation text |
| 3 | 5 | High | **privileged `git fetch` could follow agent-planted links in `.git` into the controller repo** (fixed: bundle built inside the sandbox); sandbox/policy mount lists diverged; approval retry reused a stale gate; pin not checked after the final awaited read; path redaction gaps |
| 4 | 4 | High | rename detection hid moved protected files; start/escalation writes ignored revoked authorization; CI result cached; agent prose not scrubbed of secrets/paths |
| 5 | 5 | High | privileged git applied configured filters; start re-check did not pin the project; escalation accepted any unstarted state; CI evidence unpaginated and without commit statuses; protected files checked only on the final diff, not per commit |
| 6 | 1 | High | permission-denied CI fallbacks could fail open (fixed in the next commit with tests for both denied paths) |

Trend: 7 → 5 → 5 → 4 → 5 → 1. Across all six rounds Codex reported **no demonstrated sandbox escape and no read of controller credentials by an agent**;
the high-severity findings were authority/integrity gaps in the controller around the sandbox. The reviewer also repeatedly confirmed as sound: exact-SHA /
fresh-nonce / changed-file-coverage validation, push destination and source restrictions, absence of any ready/merge API method, `O_NOFOLLOW` reads of agent
output, and the credential write-back guards.

## Unresolved risks the reviewer kept listing (inherent, not defects)

- Network egress is open (both agents must reach their model API): a prompt-injected agent can send out whatever it can read: its own clone/snapshot and its own login copy.
- A PASS attests format, SHA, nonce and coverage, not that the review was good.
- Linear and GitHub are read and written in separate calls; there is no conditional-write primitive, so a last-moment owner change can still race a transition (every transition re-reads first).
- bubblewrap, the kernel, git and the agent binaries are part of the trusted base.
- A controller crash can leave a lock and a partly written audit trail; `orchestrate release` and the retained manifest/events cover recovery.
