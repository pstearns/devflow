# DevFlow orchestration

Open DevFlow as the workspace in the VS Code Codex extension and invoke `$devflow-orchestrator` with the Linear IDs or named queue. For example, ask it to investigate one Triage ticket and process two Ready tickets. The invocation runs for the active session. A new session reconstructs context from Linear, DevFlow, and GitHub.

## Authority

The owner approves initial Ready and every entry into Triage. The configured Ready representation is the project's Ready label and an eligible unstarted state. A delegated actor may publish investigation findings and promote owner-entered Triage to Ready after verifying scope, prerequisites, and repair authority. Promotion from Backlog or Blocked and entry into Triage require the owner. The owner also controls scope expansion, security exceptions, destructive acceptance, cancellation, and merge.

The controller derives actor IDs from Linear issue history and comment authors. The deployment owner installs `/etc/devflow-linear-authority.json` as a root-owned regular file with mode `0644`. It contains `owners` and `delegates` arrays of distinct, verified Linear user UUIDs. Use separate identities and verify the identity behind the connected Linear actions before granting delegation. The controller refuses unverified history or a missing allowlist. Replacing the allowlist is an owner-operated configuration action.

Linear documents write permissions at the API key and team level. A broadly scoped Linear writer can still change an issue directly. DevFlow rejects dispatch when the observed history lacks authorized evidence. Keep the owner's Linear identity and credentials out of the orchestrator. DevFlow's controller check governs its own launch path. The workflow instructions govern the orchestrator's raw tool use, the technical adequacy of its investigation, and the decision to preserve the original ticket.

## Investigate and promote

1. Resolve the immutable issue ID and current state. Use `npm run orchestrate -- inspect <ISSUE>` to verify that the latest entry into Triage was by an allowlisted owner. Require complete history and an unambiguous actor. If the connected service cannot expose that evidence, stop before modifying the issue.
2. Read the description, comments, dependencies, earlier run records, exact-SHA checks, review findings, and PRs. Inspect the relevant source and controls. Run safe read-only validation. Separate evidence from hypotheses, compare viable corrections, and document the smallest correction and its acceptance criteria.
3. Keep the original requirements and failed-review evidence. Record agreed decisions, remaining risks, and manual gates. Ask the owner to resolve material changes. Confirm dependencies and any outstanding remediation restriction before promotion.
4. With the delegate identity, post the findings on the same issue. Use the first line `DevFlow Triage: <owner-entry-history-id> <scope-sha256>`, a blank line, and substantive findings. Compute the scope hash as lowercase SHA-256 over UTF-8 `JSON.stringify([issueId, title, description])` using the final Linear values. Re-read the issue immediately before writing. Apply the Ready label in Triage, then move to the configured Todo state. Verify both changes and their actor in Linear. If verification fails or ownership changes, preserve the evidence and report the observed partial state.
5. Dispatch through DevFlow once the promotion and other gates are verified.

## Ready queue and dispatch

Read the current issue, scope, acceptance criteria, comments, dependencies, project mapping, linked PRs, and run history. Enforce each dependency's actual completion condition, including required merge or manual acceptance. Among unblocked tickets, order by owner priority, Linear priority, technical readiness, risk, and impact. Dispatch sequentially. Continue independent tickets after an isolated blocker. Pause affected tickets if a security or environment failure is shared.

From the trusted DevFlow checkout, invoke `npm run orchestrate -- run <ISSUE>`. The controller checks its credentials, project and repository destination, isolation, approval and duplicate lock. Use `npm run orchestrate -- inspect <ISSUE>` to reconcile the run ID, stage, attempts and recorded results. Consult the retained events for finer-grained launch evidence. The accepted manifest and successful preflight establish acceptance. A `start-confirmed` event and an `implementing` handoff establish controller progress through launch. Follow actual agent results, CI, Codex review, repair and terminal outcome. A handoff without process evidence does not establish completed implementation. See [the controller reference](REFERENCE.md) for record locations and fields.

Before a retry or session restart, check the current ticket and controller history, including active locks and all previous terminal attempts. Coordinate with the existing active run. Leave interruption release to the authorized operator. Record pre-launch refusals as such.

## Exhausted repairs

A fresh Ready transition leaves prior repair restrictions in force. On the original issue, an allowlisted owner must create an unedited comment containing exactly `DevFlow remediation: <issue-uuid> <exhausted-run-id> <scope-sha256>`, using the scope hash defined above after the corrective scope is documented in the ticket. DevFlow checks the author, date, uniqueness, ticket, run ID, scope, and whether an earlier run consumed that comment. It retains exhausted runs and manifests that consumed approval during pruning. Preserve existing evidence and report missing or contradictory records. A new branch or run ID grants no extra authority. Preserve the original issue. Linear supplies no reliable mechanical equivalence test for a separately created issue with reworded requirements.

## Evidence and disposition

For a block, capture the issue, run ID if present, stage, error, branch, SHA, attempts and repairs consumed, impact on dependencies, category, next action, and owner action if needed. Use the existing Blocked status and controller reports. Preserve earlier comments and scrub private paths and credentials. An owner may route a Blocked issue into Triage.

For success, reconcile the issue, repository, draft PR, branch, exact commit SHA, required CI and actual independent verdict for that SHA, repair authorization, outstanding findings, acceptance evidence, and manual gates. Leave attended rehearsal, acceptance and merge with the owner. An orchestration assessment has no standing as a reviewer verdict.
