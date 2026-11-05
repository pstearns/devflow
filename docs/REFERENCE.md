# DevFlow reference

Detailed behaviour reference. See the [README](../README.md) for setup and the overview. Descriptions here reflect the current implementation, including its limits.

## When data is read

| Trigger | What is read |
|---|---|
| Open the dashboard | Everything, unless the server's cached data is younger than `staleAfterMinutes` (default 5) |
| Navigating between views | Nothing (derived from the loaded data) |
| **Refresh** | Everything, bypassing caches (min. 5 s apart) |
| Open an issue | Only that issue (description + fields) and its linked PRs' checks/reviews, if missing or older than the stale threshold. Other projects/repos are not touched |
| Tab becomes visible again | Re-read only if the data is older than the stale threshold |

Data age is shown in the header; data older than the threshold is badged *stale*. There is no background polling; opening the dashboard or returning to a visible tab can trigger a stale-data refresh as described above. List queries omit issue descriptions; they are fetched per issue.
Checks and reviews are treated as refreshable evidence even when the head SHA is unchanged (checks can be re-run, reviews dismissed): they are cached for at most 15 s (pending) / 2 min (settled), and Refresh bypasses the cache entirely.

## Credentials (dedicated keys, optional Linear writes)

| Variable | Minimum access |
|---|---|
| `LINEAR_API_KEY` | Personal API key, permission **Read** |
| `LINEAR_WRITE_API_KEY` (optional) | A *separate* Linear personal API key, permission **Write**, limited to the configured team(s). Enables the action menu. Must differ from `LINEAR_API_KEY` or write stays disabled. |
| `GITHUB_TOKEN` | Fine-grained PAT limited to the configured repos, all **Read-only**: Metadata, Pull requests, Contents, Actions (and Commit statuses if available) |

DevFlow never uses the `gh` CLI or any ambient identity. These keys are **not** the sign-in password; sign-in uses the local admin account above. Tokens stay on the server: not sent to the browser, not logged, never in error text (upstream error bodies are not forwarded). `.env` and `devflow.config.json` are git-ignored; DevFlow warns at startup if `.env` is readable by other users. `PORT`/`HOST` in `.env` are ignored.
CI evidence comes from GitHub Actions workflow runs for the PR's head commit. Check-run details (individual checks) need a permission this token setup does not expose, so they are shown as **Unavailable**, never as Passed; DevFlow does not ask for it. If a commit has no workflow run, its CI is **Unknown**.

## Authentication (single local admin)

DevFlow has exactly one administrator and no registration, OAuth or external identity provider. **Everything** (the app, all `/api/*` endpoints, every Linear action) requires a session; the only unauthenticated paths are the sign-in page, its static build assets, `GET /api/auth/state` and `POST /api/auth/login`. It still binds to `127.0.0.1` only.

- **Create the account** once, in a terminal: `npm run auth:setup` (hidden prompt, entered twice, minimum 15 characters). The password is never read from arguments, pipes, `.env` or the environment, and is never stored or logged. `npm run auth:reset` changes it (type `RESET` to confirm; ends every session); `npm run auth:unlock` clears a login lockout without touching the password or sessions; `npm run auth:status` prints non-secret status, including whether sign-in is currently locked. **Starting the server never creates or resets the account.** Until it exists, everything is locked and the sign-in page says how to set it up.
- **Storage:** SQLite at `~/.local/share/devflow/auth.sqlite` (override with `DEVFLOW_AUTH_DB`), outside the repository; the directory is `0700` and the file `0600` (tightened if found looser, refused if it is a symlink or owned by someone else). It holds only the **Argon2id** hash (64 MiB, 3 passes, 1 lane, via Node's built-in OpenSSL implementation, no native dependency), account metadata, session verifiers, failed-login timestamps, and the CSRF HMAC key.
- **Sessions:** a 256-bit random opaque token in an `HttpOnly; SameSite=Strict` cookie. Only its SHA-256 verifier is stored, so the database cannot be replayed as a login. Logout deletes the session server-side. A new login replaces the session presented. At most 10 live sessions.
- **30-minute sliding inactivity timeout, enforced server-side** to the millisecond. The window moves only for real user interactions: requests sent by the app with an explicit user-interaction header (opening, Refresh, selecting, actions) and a throttled `touch` sent from trusted pointer/keyboard input. Health checks, readiness, the auth-state endpoint, the automatic refresh when a hidden tab returns, static files and page loads never extend it. When it expires the next request gets `401`, and the app (which also arms one idle timer, not polling) redirects to the sign-in page.
- **Login throttling:** after 5 failed attempts the account is locked for 30 s, doubling per further failure up to 15 min; a locked account rejects even the right password. Every credential failure returns the same message.
- **CSRF:** every POST must be same-origin (`Origin` equal to the host, `Sec-Fetch-Site: same-origin` when sent) and `application/json`. Login verifies the password and does not require an existing session or CSRF token. Actions, logout, and session touch additionally require the **session-bound CSRF token** (an HMAC of the session verifier, obtained from the authenticated `GET /api/auth/session`). Ordinary actions (Ready approval, labels, status…) do **not** ask for the password again.
- **`DEVFLOW_ADMIN`:** a password in `.env` is not a supported mechanism. If the variable is set, DevFlow warns, deletes it from its environment and ignores it. Remove the line.
- Not part of this feature: HTTPS (the service is loopback-only, so cookies are not marked `Secure`), MFA, password-reset by e-mail, multiple users.

## Teams → Projects

DevFlow discovers every Linear team the read key can see (nothing is hard-coded) and shows **Team › Project** selectors in the header. *All teams* shows whatever is loaded; a team shows **all** of its issues, including ones outside any project; a project shows only its issues; *No project* shows only unprojected issues. Overview, Milestones & Tasks, Pipeline, Activity, label filters, source links and issue details are all scoped to the selection, and switching team or project discards the open ticket, panels and per-view filters.

Teams named in config are read when the dashboard opens; any other accessible team is read **only when you first select it** (`GET /api/team/<KEY>`; other teams, projects and repositories are not touched). Labels are team labels plus applicable workspace labels, with Linear's own names and colors. Milestones stay per project, with a "No milestone" group per project and a separate "Not in a project" group for unprojected issues. Projects and teams without a GitHub repository are fine: they simply show no PR/CI evidence. A GitHub PR links to an issue only if **that issue's own project or team lists the PR's repository**.

**Policy and write authorization are resolved by the server from the issue's live team/project and your config, never from the browser's selection:**

| Issue is in… | Policy | Writes |
|---|---|---|
| a Linear project covered by a `projects[]` entry (it names the project, or its `linear.projects` is empty = every project of the team) | that project's `workflow` | authorized |
| any other project, or no project | the team's `teams[]` entry if it has a `workflow` (explicit policy); otherwise none | only if `teams[].write` is `true` **and** it has a `workflow` (`write: true` without one is a config error: the ready label would be unprotected) |
| a team with no `teams[]` entry | none (generic defaults for display only) | refused |

Approving for execution requires an **explicit** policy for the exact scope; unprojected issues never inherit a project's rules. Per-team entries look like:

```json
"teams": [{ "key": "ABC", "write": true, "workflow": { "readyLabel": "Ready" }, "github": { "repos": ["org/repo"] } }]
```

**Migrating an existing config:** nothing breaks. `projects[]` entries keep working unchanged (their issues keep their rules, repos and write access). What changes: issues **outside** the covered projects (unprojected issues, other projects) are now visible, read-only, and do not inherit the project's workflow; add a `teams[]` entry (with `write: true` and a `workflow`) to enable approval/edits for them.

## Controlled Linear actions (optional)

With a separate **`LINEAR_WRITE_API_KEY`** (a different personal API key from `LINEAR_API_KEY`, permission *Write*, access limited to the configured team(s)), each issue card and the detail panel get an **Actions** menu:

| Action | Rules |
|---|---|
| Edit labels | Add/remove ordinary labels (one add/remove mutation per label, never a full replacement of the label set, so other labels are left alone; a multi-label change can be partially applied if a later mutation fails). Result is read back after the writes return; a write that throws is reported without a readback. Group labels and **protected workflow labels (the Ready label)** cannot be edited here. |
| Change status | Sent to Linear as requested; **Linear decides** what is allowed. DevFlow has no rules of its own (no Ready requirement, no merged-PR requirement, no blocked transitions), reads the issue back and shows the actual result. |
| Set milestone | Only milestones of the issue's own Linear project; can be removed. |
| **Approve for execution** | An explicit action with typed confirmation. Needs only what it technically requires: write access, an authorized team/project, the Ready label and a Todo state in Linear. It does not judge the ticket (description, blockers, milestone and so on are Linear's and your business). It does what you would do in Linear: **Todo** + the **Ready** label, re-reads Linear and shows what Linear reports. If a step fails or Linear's answer differs, DevFlow shows the state Linear actually has; it keeps no record of its own and does not roll anything back. Works the same for tickets with no GitHub PR. |
| Revoke readiness | Removes Ready and returns the issue to Backlog, re-reads Linear and shows what it reports. |

Without the write key, or for a team/project that config does not authorize, every action stays visible but disabled, with the reason. DevFlow never merges PRs, deletes or bulk-edits issues, starts agents, or writes to GitHub. Every action re-reads the issue, team labels and states from live Linear before acting; it never trusts cached data or browser-supplied names.

**Host and cookies:** the app answers only to `devflow.localhost:<port>` (exact match; any other Host gets 403). Browsers (Chrome, Edge, Firefox) resolve `*.localhost` to loopback themselves and the session cookie is host-only, so it is never shared with other apps on `localhost`. A GET/HEAD page request to bare `localhost`/`127.0.0.1` is redirected there; the API is not. The server still binds `127.0.0.1` only. Observed from WSL2 with Windows Chrome (default localhost forwarding), not exhaustively tested across platforms; Windows tools that use the OS resolver (e.g. `curl.exe`, PowerShell) cannot resolve the name, so send a `Host: devflow.localhost:<port>` header to `127.0.0.1` instead.

**Paths and cross-site reads:** every request path is decoded and validated once (`normalizePath`) and that single result drives both the sign-in gate and static serving; malformed or double encoding, encoded or backslash separators, `.`/`..` and empty segments get 400, and `/assets/` never falls back to the app shell. `/api/*` also refuses browser requests that are not same-origin (`Sec-Fetch-Site`/`Origin`), so a page on another local port cannot trigger refreshes. A session also ends if the system clock moves backwards. Node 24.7+ is enforced at startup, and `npm run auth:status` never creates files.

**Security model:** the server accepts GET/HEAD and allows POST routes only under `/api/auth/` and `/api/actions/`. Requests must use the dedicated `devflow.localhost:<port>` Host; POST requests require exact same-origin checks and JSON. Login accepts at most 2 KiB and verifies the admin password. Logout and touch accept at most 512 bytes; controlled actions accept at most 8 KiB. These authenticated POST routes require a valid session and its session-bound CSRF token. The CSRF HMAC key is persisted in the local authentication database, not generated per process.

The Linear read client accepts only queries. The separate write client exposes exactly three fixed mutations (`issueAddLabel`, `issueRemoveLabel`, `issueUpdate` limited to `stateId`/`projectMilestoneId`), and action execution is serialized. GitHub remains read-only. A process merely reaching the loopback port does not gain write access: it must authenticate and satisfy the request guards. The application does not protect against a compromised OS account that can read credentials, alter the authentication database, or inspect the running process. Leave the optional write key unset when you only need inspection.

## Lifecycle stages

**Backlog → Discovery → Ready → Implementation → CI → Independent Review → Human Merge → Done**, derived from real Linear state and labels plus verified GitHub evidence. *Discovery* = a backlog/triage/Todo issue carrying one of the project's `discoveryLabels`; plain backlog issues are **Backlog**, not Discovery. *Ready* requires **both** an unstarted (Todo) state **and** the Ready label (a Todo issue without the label is "not authorized" and stays in Backlog). Classification labels (Idea, Bug, Security, Feature, Research, Tech Debt…) are shown as labels and filterable but are never stages. All label/state names are per-project configuration (`workflow` below), not code.

## Configuration (`devflow.config.json`)

See `devflow.config.example.json`. Per project: `linear.teamKey` (+ optional `linear.projects`), `github.repos`, `knowledge` (Obsidian path, repo file, or URL). Per project `workflow` (all optional; defaults shown in the example): `readyLabel`, `discoveryLabels`, `classificationLabels`, `protectedLabels`, `todoState`, `backlogState`. (Older `readiness` settings in a config are ignored.) Top level: `staleAfterMinutes`, `staleDays`, `idleExitMinutes`, `obsidian.vault`/`vaultPath`, `prompts` (`{{project}}`, `{{ticket}}`, `{{milestone}}`), `review`.

**Independent review (Codex) evidence** is never assumed: it is *Passed* only if you configure where it is recorded (`review.checkName`, `review.passedLabel`, `review.findingsLabel`); otherwise *Unknown*.

## How things are decided

- **Ticket↔PR link**: only explicit evidence (identifier in branch or PR title, Linear GitHub attachment, Linear `branchName`). Several tickets or none known → *ambiguous* / *unlinked*, never guessed.
- **Status values**: Passed / Failed / Pending / Unknown / N/A with the evidence source. Cancelled/stale checks, truncated lists (over 300 items) and unreadable statuses make CI *Unknown*, never *Passed*; incomplete review lists likewise.
- **Stage** precedence, first match wins: a canceled Linear state is not staged; a *completed* Linear state is **Done** regardless of PR, CI or review state; otherwise a **merged** primary PR is **Human Merge** (Linear still open) regardless of CI or review state; only for an unmerged PR does the rest apply: draft or failing CI or review findings put it in Implementation (↺ rework), then pending CI is CI, then review and merge stages. Failed CI/review therefore never moves a completed or merged ticket back.
- **Milestone progress** = completed / (issues − canceled), from real Linear states.
- **Failures**: per-source health; the last good data stays visible, marked stale. A rate limit on one source pauses the whole credential until reset (honouring `Retry-After` and GitHub secondary limits, capped at 1 h).

