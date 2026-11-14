# DevFlow reference

Detail behind the [README](../README.md). Linear and GitHub own their records, DevFlow shows the evidence, and a person approves. Automated tests use synthetic Linear and GitHub services. DevFlow is also used day to day with live Linear and GitHub data, including updates to Linear labels and statuses. GitHub access is read-only.

## When data is read

| Trigger | What is read |
|---|---|
| Open the dashboard | Everything, unless cached data is younger than `staleAfterMinutes` (default 5) |
| Navigate between views | Nothing |
| **Refresh** | Everything, bypassing caches (at least 5 s apart) |
| Select a team that config does not name | That team only. It stays loaded on later refreshes. |
| Open an issue | That issue (with description) and, for its linked PRs, the PR plus checks, statuses, reviews and commits, if missing or older than the stale threshold |
| Hidden tab becomes visible | Everything, only if data is older than the threshold. This does not extend the session. |

There is no background polling. The header shows the age of the oldest source; older than the threshold is badged *stale*. A source whose last refresh failed is also *stale*, and its last good data stays visible. List queries omit descriptions; a fetched description is dropped when the issue's `updatedAt` changes.

**Caching.** Everything is cached in memory. PR evidence has its own lifetimes: check runs and commit statuses 15 s while pending or empty and 2 min once settled, reviews and PR commits 2 min, repo workflow runs 15 s. Refresh bypasses all of them, and opening an issue bypasses them for that issue's PRs, because checks can be re-run and reviews dismissed on an unchanged SHA.

**Failures.** Each source reports ok, partial, stale, error or not configured. A refresh that runs past 90 s is cancelled and the previous data stays. A rate limit pauses that credential until its reset (Linear's reset header; GitHub's `Retry-After` or reset), clamped to 5 s – 1 h, or 60 s if none is given. Upstream error bodies are never forwarded.

## Read limits

| Source | Limit |
|---|---|
| Linear issues | 40 per page, 25 pages (1,000) per team, then a partial-data warning |
| Per issue | 20 labels, 20 relations each way, 10 attachments, 5 history entries (the state transitions among them are shown); descriptions cut at 10,000 characters |
| Teams, projects, labels, milestones | 50 projects listed per team (a warning beyond that); labels 100 per page and milestones 50 per page, 25 pages each |
| GitHub PRs | The 100 most recently updated per repo |
| PR detail | Open PRs and PRs updated in the last 14 days, up to 30 per repo; others show "details not fetched" |
| Per PR | Up to 300 each of check runs, statuses and reviews (more means Unknown); 50 commits |
| Workflow runs | The 40 most recent per repo |

## Credentials

| Variable | Minimum access |
|---|---|
| `LINEAR_API_KEY` | Personal API key, permission **Read** |
| `LINEAR_WRITE_API_KEY` (optional) | A *separate* Linear personal API key, permission **Write**, ideally limited to the configured team(s). Enables the Actions menu. Must differ from `LINEAR_API_KEY` or writes stay disabled. DevFlow itself writes only to scopes your config authorizes. |
| `GITHUB_TOKEN` | Fine-grained PAT limited to the configured repos, all **Read-only**: Metadata, Pull requests, Contents, Actions (and Commit statuses if available) |

DevFlow never uses the `gh` CLI or any ambient identity. These keys are not the sign-in password. Tokens stay on the server: not sent to the browser, not logged, never in error text. `.env` and `devflow.config.json` are git-ignored; DevFlow warns at startup if `.env` is readable by other users.

**CI evidence.** DevFlow requests check runs and commit statuses for the PR head commit. With the token above, check runs are denied, so CI comes from the latest run of each workflow for that commit, within the repo's 40 most recent runs, and the PR shows "check-run details unavailable". If check runs are readable but commit statuses are not, CI is Unknown. If no workflow run is found, CI is Unknown. Evidence that is missing is never shown as Passed.

## Authentication (single local admin)

DevFlow has one administrator and no registration, OAuth or external identity provider. Everything (the app, all `/api/*` endpoints, every Linear action) requires a session. The only unauthenticated paths are the sign-in page, its static build assets, `GET /api/auth/state` and `POST /api/auth/login`.

- **Account.** Create it once in a terminal with `npm run auth:setup` (hidden prompt, entered twice; 15–128 characters, at least 6 distinct). The password is never read from arguments, pipes, `.env` or the environment, and is never stored or logged. `auth:reset` (type `RESET`) changes it, ends every session and clears any lockout. `auth:unlock` clears a lockout only. `auth:status` prints non-secret status and creates nothing. Starting the server never creates or resets the account; until it exists, everything is locked and the sign-in page says how to set it up.
- **Storage.** SQLite at `~/.local/share/devflow/auth.sqlite` (override with `DEVFLOW_AUTH_DB`), outside the repository. The directory is `0700` and the file `0600`; looser permissions are tightened, a symlink or a different owner is refused. It holds the **Argon2id** hash (64 MiB, 3 passes, 1 lane, via Node's built-in implementation), account metadata, session verifiers, failed-login timestamps and the CSRF HMAC key.
- **Sessions.** A 256-bit random opaque token in an `HttpOnly; SameSite=Strict` host-only cookie. Only its SHA-256 verifier is stored. Logout deletes the session server-side, a new login replaces the session presented, and at most 10 sessions are live.
- **30-minute sliding inactivity timeout, enforced server-side.** The window moves only for real user interactions: app requests that carry the user-interaction header (opening, Refresh, selecting, actions) and a throttled `touch` from trusted pointer or keyboard input. Health checks, readiness, the auth-state endpoint, the automatic refresh when a hidden tab returns, static files and page loads never extend it. A session also ends if the system clock moves backwards. After expiry the next request gets `401` and the app redirects to sign-in.
- **Login throttling.** After 5 failed attempts within 15 minutes the account locks for 30 s, doubling per further failure up to 15 min. A locked account rejects the right password too, with a distinct 429. A wrong password always returns the same message. At most 8 logins are queued; more get 429 "busy".
- **CSRF.** Every POST must be same-origin JSON. Login needs no session or CSRF token. Actions, logout and touch also need the session-bound CSRF token (an HMAC of the session verifier, from the authenticated `GET /api/auth/session`). No action asks for the password again; Approve and Revoke require typing the issue identifier.
- **`DEVFLOW_ADMIN`.** A password in `.env` is not supported. If the variable is set, DevFlow warns, deletes it from its environment and ignores it.

Not provided: HTTPS (the service is loopback-only, so cookies are not `Secure`), MFA, e-mail password reset, multiple users.

## Teams → Projects

DevFlow discovers every Linear team the read key can see and shows **Team › Project** selectors in the header. *All teams* shows whatever is loaded; a team shows **all** of its issues, including ones outside any project; a project shows only its issues; *No project* shows only unprojected issues. Overview, Milestones & Tasks, Pipeline, Activity, label filters, source links and issue details are all scoped to the selection, and switching team or project discards the open ticket, panels and per-view filters.

Teams named in config are read when the dashboard opens; any other accessible team is read only when you first select it (`GET /api/team/<KEY>`). Labels are team labels plus applicable workspace labels, with Linear's own names and colors. Milestones stay per project, with a "No milestone" group per project and a "Not in a project" group for unprojected issues. Projects and teams without a GitHub repository show no PR or CI evidence. A GitHub PR links to an issue only if that issue's own project or team lists the PR's repository.

**Policy and write authorization are resolved by the server from the issue's live team and project and your config, never from the browser's selection:**

| Issue is in… | Policy | Writes |
|---|---|---|
| a Linear project covered by a `projects[]` entry (it names the project, or its `linear.projects` is empty = every project of the team) | that project's `workflow` | authorized |
| any other project, or no project | the team's `teams[]` entry if it has a `workflow` | only if `teams[].write` is `true` **and** it has a `workflow` (`write: true` without one is a config error, because the ready label would be unprotected) |
| a team with no `teams[]` entry | none (generic defaults for display only) | refused |

Approving for execution requires an explicit policy for the exact scope; unprojected issues never inherit a project's rules. A per-team entry looks like:

```json
"teams": [{ "key": "ABC", "write": true, "workflow": { "readyLabel": "Ready" }, "github": { "repos": ["org/repo"] } }]
```

Issues outside the projects covered by `projects[]` are visible and read-only until a `teams[]` entry with `write: true` and a `workflow` covers them.

## Controlled Linear actions (optional)

With a separate `LINEAR_WRITE_API_KEY`, each issue card and the detail panel get an **Actions** menu:

| Action | Behaviour |
|---|---|
| Edit labels | 1–20 labels per request; adds run before removes, one mutation per label, so a multi-label change can be partially applied. Group labels and protected labels (the ready label plus `protectedLabels`) cannot be edited here: the ready label changes through Approve and Revoke, any other protected label in Linear. After the writes DevFlow verifies the exact resulting label set. If a write itself fails, the error is reported without a readback. |
| Change status | Sent as requested; **Linear decides** what is allowed. DevFlow only skips the current state. It reads the issue back whether or not the write threw. |
| Set milestone | Milestones of the issue's own project only; can be removed. Read back after the write; a write that fails is reported without a readback. |
| **Approve for execution** | Type the issue identifier. Sets the Todo state, then adds the ready label, and reads back both. Todo is the unstarted state named `todoState`, else the first unstarted state. Prerequisites: write key, authorized scope, an existing ready label (DevFlow never creates labels) and a Todo state. |
| **Revoke readiness** | Type the issue identifier. Removes the ready label, then moves the issue to the backlog state (`backlogState`, else the first backlog state), and reads back both. The issue must currently have the ready label. |

Label edits and Approve need the team's complete label list. If Linear's label pages cannot all be read (25-page cap or malformed paging), they are refused with "label list incomplete" and nothing is sent; status, milestone and Revoke do not use that list and are unaffected.

Without the write key, or outside an authorized scope, actions are visible but disabled with the reason. Every action re-reads the issue from live Linear first (plus the team's labels for label edits and Approve), runs one at a time, and on success returns a fresh snapshot. Status, Approve and Revoke read back even after a failed write and report the observed result or that it is unknown. Label and milestone actions read back only after their writes succeed; a write failure is reported without a readback. It keeps no record of its own and rolls nothing back. DevFlow never merges PRs, deletes or bulk-edits issues, starts agents, or writes to GitHub.

## Request handling

- **Host.** The app answers only to `devflow.localhost:<port>`; any other Host gets 403. A GET/HEAD page request to bare `localhost`, `127.0.0.1` or `[::1]` is redirected there (308); the API is not. Browsers resolve `*.localhost` to loopback themselves, and the host-only cookie is never shared with other local apps. This was observed from WSL2 with Windows Chrome and has not been tested across platforms. Tools that use the OS resolver (`curl.exe`, PowerShell) cannot resolve the name; send a `Host: devflow.localhost:<port>` header to `127.0.0.1` instead. The server binds `127.0.0.1` only.
- **Methods and origin.** GET/HEAD, plus POST only under `/api/auth/` and `/api/actions/`. `/api/*` refuses browser requests that are not same-origin (`Sec-Fetch-Site`, `Origin`), so a page on another local port cannot trigger refreshes. POST bodies are limited to 2 KiB (login), 512 B (logout, touch) and 8 KiB (actions).
- **Paths.** Every path is decoded and validated once (`normalizePath`), and that result drives both the sign-in gate and static serving. Malformed or double encoding, encoded or backslash separators, `.`/`..` and empty segments get 400, and `/assets/` never falls back to the app shell.
- **Headers.** `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Upstream clients.** The Linear read client sends queries only. The write client exposes exactly `issueAddLabel`, `issueRemoveLabel` and `issueUpdate` (limited to `stateId` / `projectMilestoneId`). The GitHub client sends GET to `/repos/` only.
- **Health.** `/api/healthz` and `/api/readyz` call no upstream and sit behind the session gate. `readyz` returns 503 if the web build is missing or a refresh has run longer than 120 s.
- **Not protected against:** a compromised OS account that can read credentials, alter the auth database or inspect the process. Leave the write key unset when you only need inspection.

## Lifecycle stages

**Backlog → Discovery → Ready → Implementation → CI → Independent Review → Human Merge → Done**, derived from Linear state and labels plus GitHub evidence. Classification labels (Idea, Bug, Security, Feature, Research, Tech Debt…) are shown and filterable but are never stages. Label and state names are per-scope configuration (`workflow`), not code.

**Primary PR.** The most recently updated open linked PR, otherwise the most recently updated merged one. A PR closed without merging does not count.

**Stage precedence**, first match wins:
- A canceled Linear state is not staged. A completed Linear state is **Done**, whatever the PR says.
- A merged primary PR is **Human Merge** (Linear still open), whatever its CI or review state.
- An open PR: a draft, failing CI, or failing review → **Implementation** (rework). CI not Passed (pending or Unknown) → **CI**. Independent or human review Passed → **Human Merge**, awaiting the merge decision. Otherwise → **Independent Review**.
- No PR: a started issue is **Implementation** (**Independent Review** if its state name contains "review"). Backlog, triage and Todo issues are **Ready** (Todo state and the ready label), **Discovery** (a discovery label) or **Backlog**. The ready label on a non-Todo state is not treated as Ready.

**Markers.**
- *Blocked*: an unresolved Linear "blocks" relation, a state name containing "blocked", or a label named `blocked`. Readiness is ready, not ready, blocked, or n/a.
- *Rework (↺)*: failed CI, requested changes, or recorded independent-review findings.
- *Awaiting you*: a merge decision.
- *Stale*: a started issue with no Linear or PR update for `staleDays`.
- *Overdue*: a milestone past its target date with open work.

## Configuration

`devflow.config.json` (see `devflow.config.example.json`). Unknown fields are ignored.

| Key | Meaning |
|---|---|
| `port` | Default 4317 |
| `staleAfterMinutes`, `staleDays` | Stale threshold for data (1–120, default 5) and for started issues (default 5) |
| `idleExitMinutes` | Exit after this long with no request (0–1440; default 0 = never) |
| `projects[]` | `id`, `name`, `linear` (`teamKey`, optional `projects`), `github.repos`, `knowledge`, `workflow`, `criticalPath` |
| `teams[]` | `key`, `write`, `workflow`, `github.repos`, `knowledge` |
| `workflow` | `readyLabel` (Ready), `discoveryLabels` (Discovery), `classificationLabels`, `protectedLabels` (none), `todoState` (Todo), `backlogState` (Backlog) |
| `criticalPath[]` | Ordered, human-approved gate tickets: `"ABC-1"` or `{ "ticket": "ABC-2", "deferred": true }`. The Overview's "Next milestone blocker" card shows the first unresolved non-deferred gate (blocked / needs authorization / executable / in flight) and links to the ticket that can advance it. Deferred entries are listed separately and never block. A blocker outside the loaded data links to its Linear page. Parsed strictly: a non-array, more than 200 entries, a malformed or duplicate identifier, an unknown field or a non-boolean `deferred` stops startup with a message; nothing is truncated or ignored. Read-only; DevFlow does not infer the path. |
| `knowledge[]` | `obsidian` (`title`, `path`), `repo` (`title`, `repo`, `path`, `ref`) or `url` (`title`, `url`) |
| `obsidian` | `vault`, `vaultPath` |
| `prompts` | Overrides for `discover`, `execute`, `review`, `resolve`, `resume`, `milestone`; placeholders `{{project}}`, `{{ticket}}`, `{{milestone}}` |
| `review` | `checkName`, `passedLabel`, `findingsLabel`: where independent-review evidence is recorded |

**Environment.** `DEVFLOW_PORT` sets the port. Normal-mode precedence is the environment, then `.env`, then the config `port`, then 4317, and the launcher resolves it the same way. With `DEVFLOW_DEMO=1` in the environment, both skip `.env` and normal config, using the environment port or 4317. `DEVFLOW_CONFIG` points at another config file, `DEVFLOW_AUTH_DB` at another auth database, `DEVFLOW_DEMO=1` serves synthetic data, and `DEVFLOW_ACCESS_LOG=1` logs method and path only. The launcher also reads `DEVFLOW_NO_BROWSER` and `NODE_BIN`.

## How things are decided

- **Ticket↔PR link.** Only explicit evidence: an identifier in the branch or PR title, a Linear GitHub attachment, or the Linear `branchName`. Several tickets or none known gives *ambiguous* / *unlinked*, never a guess.
- **Status values.** Passed / Failed / Pending / Unknown / N/A, with the evidence source. Cancelled or stale checks, truncated lists (over 300 items), malformed answers and unreadable statuses make CI *Unknown*, never *Passed*; incomplete review lists likewise.
- **Human review** uses the latest decisive review per reviewer. Changes requested fails it; an approval passes it.
- **Independent review** is *Passed* only from evidence you configure in `review.*`: a findings label fails it, a named check or a passed label passes it. Otherwise it is *Unknown* (pending on an open PR with sources configured).
- **Milestone progress** = completed / (issues − canceled).


## Agent orchestration (M1)

Per project, in `devflow.config.json` (omit the block to forbid orchestration for that project):

```json
"orchestration": {
  "repo": "your-org/your-repo",          // must be in the project's github.repos
  "repoPath": "/abs/path/to/clone",      // the controller's own clone; `origin` must be that repo
  "runsDir": "/abs/path/to/devflow-runs",
  "baseBranch": "main",
  "startedState": "In Progress",         // started-type state
  "approvalState": "In Review",          // PASS lands here; must NOT be completed/canceled
  "blockedState": "Blocked",             // every escalation lands here; must exist (checked before work starts)
  "infraRetries": 2,                     // per environment step; never consumes a repair
  "ciChecks": ["build"],                 // required check names; empty = all reported checks, green on two polls
  "ciTimeoutMinutes": 20, "agentTimeoutMinutes": 30,
  "claude": { "bin": "/abs/path/to/claude", "allowedTools": ["Read", "Edit", "Bash(git commit:*)"] },
  "codex": { "bin": "/abs/path/to/codex" }  // BOTH binaries must be explicit absolute paths (no PATH lookup); the directory containing each is mounted read-only (Codex needs its sibling helpers)
}
```

**Controller authority and policy isolation.** The controller is privileged (Linear writes, git push, PRs, agent dispatch), so its authority has one source: the owner's `devflow.config.json` and `.env` in DevFlow's own directory. The CLI changes into that directory before loading anything, so running it from inside a target repository cannot make that repository supply credentials or policy. Before each run, `policy.ts` verifies and pins: the config is a regular file owned by you, not group/world-writable, and outside `repoPath` and `runsDir`; both agent executables exist, are owned by you or root, are not group/world-writable, are not inside a repository or run directory, and their directories contain no controller-sensitive path (the whole directory is mounted into the sandbox); `runsDir` and `repoPath` do not overlap; the Node toolchain prefix that gets mounted contains no controller data and is not group/world-writable; `allowedTools` are plain tool patterns (no flags, commas, newlines). The digest of all of that is recorded in the manifest and re-verified inside every privileged operation (each push, PR call and Linear transition, including every retry), before each agent dispatch and each non-recovery Linear comment, and at the gate; only the escalation path, which must be able to tell you the policy failed, skips it; any change or inability to verify stops the run (`policy-violation`) and nothing further is executed. Nothing from a ticket, repository, commit, agent output or agent environment is ever read as policy: a repository's `devflow.config.json`, `.env`, `.claude/`, `AGENTS.md` and the like are ordinary data. Commits that touch `.github/`, `.claude/`, `.codex/`, `.cursor/`, `.vscode/`, `.zed/`, `.devflow/`, `.husky/`, `.env*`, `devflow.config*`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` or `.gitmodules` are rejected as implementation failures. No orchestrator module uses a shell; every subprocess is an argv array. The controller never reads Linear comments, and ticket text is passed to agents as quoted data.

**Linear audit trail.** One authoritative ticket, six milestone comments in a fixed shape (header, *what happened*, *why*, *evidence*): 1 execution authorized and started (who authorized, from Linear's own history; approved scope; base SHA; agent roles and versions; policy digest; limits); 2 implementation completed (commit, parent, PR, controller checks); 3 CI verified (per-check results for that SHA); 4 independent review completed (verdict, controller verification row, quoted agent findings); 5 repair requested (reason, counters; the following 2 is titled "Repair N completed"); 6 final status (awaiting owner approval or escalated, attempt table, retry counters, owner action required). A run with one repair is 8 comments. The reviewer's verdict is a claim: it is published and acted on only after the controller's gate confirms the review is for this SHA, CI is green on it, the remote branch and PR head are at it, all changed files are attested, and policy is intact. Agent-authored text is always quoted and labelled unverified, with `@` mentions, markdown links and images neutralized. Comments carry no host paths, environment or credentials (controller diagnostics are redacted to `(redacted-path)`; the raw text stays in local evidence; all agent-derived text has line endings normalised, backslashes, brackets, angle brackets, `@` and `://` neutralised, and is quoted); evidence is referenced relative to `runsDir`. The manifest, append-only `events.jsonl` and evidence files remain the detailed technical record.

**Per-project resolution.** The agent runner and the policy pin are built from the authorized ticket's own project block (a team can have several projects with different binaries and tool policy); the CLI re-reads the config from disk and re-resolves that same project id for every verification.

**Git handling.** Privileged git calls that only touch local objects run with the owner's global/system git config disabled (no configured filter or alias can be selected by repository `.gitattributes`); only push/ls-remote/fetch-origin use the ambient credentials. The reviewer snapshot is written from tree and blob objects directly (exact committed bytes, symlinks and the executable bit preserved, `..`/`.git` path components refused). Protected-path checks cover every path touched by any new commit, not just the final diff, so a file touched and reverted inside the history is rejected; a repair then rebuilds the *unpushed* commits from the base. Bundle import runs with `transfer.fsckObjects`.

**Gate details.** Changed files are computed with `--no-renames`, so moving a protected file shows as deleting it. CI evidence is complete or an error (check runs and commit statuses are paginated; a partial list is never green) and is re-read (not trusted from the earlier poll) at the gate and on every approval attempt; red or not-yet-green stops the run. Authorization is re-checked immediately before the start transition, and an escalation writes the Blocked state only if the ticket is still where DevFlow left it and still authorized; otherwise it leaves the owner's state alone and says so. Credential-shaped strings and absolute host paths are scrubbed from all agent prose before it is published (raw output stays in local evidence).

**Live ticket revalidation.** Every approval attempt (including retries after backoff) re-reads the live ticket and requires the same authorizing project scope, continued write authorization, the approval label still present and the ticket still in the state DevFlow put it in. If the owner moved, re-scoped or un-approved it, the run stops with `ticket-changed` and DevFlow writes no state at all; escalation never reopens a completed/canceled ticket.

**Pull requests.** DevFlow reuses an existing PR only if it is open, a draft, from the run branch of this repository, onto the configured base; and the same checks plus the head SHA run at the final gate, so a PR marked ready or retargeted mid-run blocks the PASS.

**Feature-branch-only writes.** `git push` is refused in code for any destination other than `devflow/<ticket>-<run>` and any source other than a private `refs/devflow/<run>/attempt-N` ref, and is never forced; PRs can only be opened from such a branch and are always drafts. The run also records whether the base branch is protected on GitHub; enabling a ruleset on it is still recommended because a write-capable token could otherwise push to it outside DevFlow.

**Credentials.** `LINEAR_API_KEY` (read), `LINEAR_WRITE_API_KEY` (a different key; the write client has create-only `commentCreate`), `GITHUB_TOKEN` (read; CI and PR-head polling), `GITHUB_WRITE_TOKEN` (a different token with *Pull requests: write*; the only GitHub write, `POST /pulls` with `draft:true`, no ready/merge/close/comment methods exist). The controller pushes one `devflow/<ticket>-<run>` branch with your own git credentials. Agents get none of these. Agent logins (`~/.claude/.credentials.json`, `~/.codex/auth.json`) are **copied** into a throw-away home per invocation (nothing else from `~/.claude` or `~/.codex`: no settings, hooks, MCP servers, history). If the agent refreshed its token and the host file was unchanged meanwhile, the refreshed file is written back atomically. `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` or `OPENAI_API_KEY` in the controller's environment are passed through to the matching agent only.

**Isolation (bubblewrap, no image, no daemon).** Both agents: new user/mount/pid/ipc/uts namespaces, cleared environment, read-only root, read-only `/usr`, own tmpfs `/tmp` and home, network on (see limits). The implementer additionally gets its clone at `/work` (read-write) and nothing of the host: not `$HOME`, not `repoPath`, not `.env`, not `~/.ssh`, not `/mnt`, not the Docker socket. The clone is a standalone repository seeded by `git fetch` from the base commit, with no remote and objects copied, so it cannot alter or push to the real repository. The controller never runs git against the agent's directory: after Claude exits, `git bundle create` of the run branch runs in a fresh sandbox (links the agent planted inside `.git` that point at host paths dangle there, so the build simply fails), the bundle is read back through a no-follow regular-file read into controller-owned evidence, and only that file is fetched (`bundle verify`, hooks disabled). The commit is then verified in the controller's repo (ancestry, non-empty diff, no edits under `.github/`). The reviewer gets only an exported tree of the SHA, read-only, with no `.git` (exported with `checkout-index`, because `git archive` honours `export-ignore`), plus one writable `/out` for its final message. The snapshot is hashed before and after; any change discards the review as tampering (no retry). A sandbox is a hard requirement: without working bubblewrap the preflight fails and nothing runs. The preflight also refuses a missing, unparseable or incompatible binary: each CLI must report a version and its own `--help` must list every flag the controller passes (`CLAUDE_FLAGS`/`CODEX_FLAGS` in `agents.ts`).

**Failure classes.** *Repair* (counts toward the limit of 3; the first attempt is no exception): review FAIL, red CI, no usable commit, a commit that touches protected files. *Infrastructure* (retried `infraRetries` times, never counts): sandbox/CLI/login failure, agent timeout or abnormal exit without delivering, push, PR creation or head mismatch, GitHub/Linear API errors. Other stops: `review-invalid` (malformed output twice), `reviewer-tamper`, `stale-commit`, `ticket-changed`, `ci-timeout`. Every stop writes `escalation.json` (class, reason, attempts, infra events, PR, branch), comments its hash on the ticket and moves it to `blockedState`.

**Run directory** `<runsDir>/<ISSUE>-<runId>/`: `manifest.json`, `events.jsonl`, `escalation.json` (if any), `clone/` (kept unless PASS), `attempt-N/{claude-prompt,claude-output,ci.json,codex-prompt,codex-output[-tryK],review.json,changes.patch,review*/context/}`. Locks: `<runsDir>/locks/<ISSUE>.lock`.

**Cleanup.** Review snapshots and scratch `out*` dirs are deleted after validation (the SHA reproduces them). Staged credential homes are deleted after every invocation. After PASS the clone and the private `refs/devflow/<run>/*` refs are removed, but only when the approved SHA is on the remote branch. Evidence is never deleted. `runsDir` is outside the repository; prune old run directories yourself.

**Known limits (M1).**
- Network egress is not filtered: both agents must reach their model API, so the sandbox cannot be network-isolated. A prompt-injected agent could send what it can read (its own clone/snapshot and its own login copy) elsewhere. It cannot read anything else of yours.
- The agent logins are copies, and the reviewer/implementer each hold *their own* login for the duration of a call. Treat a compromised agent as having its own subscription token.
- Reviewer honesty is not verifiable: the controller checks format, SHA, nonce and coverage, not that the reviewer reasoned well.
- Bubblewrap needs unprivileged user namespaces (works under WSL2; may not in some CI containers, where the sandbox tests skip and the run refuses).
- If CI only runs on `pull_request`, the draft PR created by the first push is what triggers it; with no CI at all the run escalates as `ci-timeout`.
- The reviewer's final message is read from `/out` with `O_NOFOLLOW`, a regular-file check and a size cap, because the directory is agent-writable.
- Node (and npm) are mounted read-only from the controller's own toolchain prefix so agents can run tests; other toolchains need an equivalent mount (not configurable yet).
