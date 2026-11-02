# DevFlow

Local-first dashboard over **Linear** (GraphQL) and **GitHub** (REST). **GitHub is strictly read-only. Linear is read-only unless you add a separate write key**, which enables a small set of controlled actions (see *Controlled Linear actions*). pipeline, milestones & tasks, PRs/CI/review evidence, activity, attention queue, prompt library, project knowledge links.

React + Vite + Tailwind frontend, Fastify backend, no database. **No polling:** data is read only when you open the dashboard, press **Refresh**, or open an issue. With no browser connected, DevFlow makes zero Linear/GitHub requests. It binds to `127.0.0.1:4317` only.

## Run

```bash
npm install
cp .env.example .env && chmod 600 .env                 # add the two read-only credentials
cp devflow.config.example.json devflow.config.json     # describe your projects
npm run build                                          # web + compiled server (one time, and after code changes)
npm start                                              # plain Node, no build step, no tsx: http://localhost:4317
```

- `npm run demo` – clearly labelled **synthetic** data (fake `fetch`, no network, no credentials).
- `npm test` · `npm run typecheck` · `npm run audit`.
- Development: `npm run dev:server` (tsx watch) and `npm run dev:web` (Vite on :5173, proxies `/api`).
- Startup is strict: a missing config, missing web build, or occupied port 4317 exits non-zero with a message (no silent port drift). `GET /api/healthz` = liveness, `GET /api/readyz` = readiness; neither calls Linear/GitHub.

## On-demand launcher (Windows + WSL)

`windows\DevFlow.cmd` (double-click, or copy/pin it anywhere) starts DevFlow in WSL and opens the dashboard. It runs the server in the foreground of that console window: **close the window to stop DevFlow**. The server keeps running while idle (and makes no upstream requests); set `idleExitMinutes` in the config only if you want it to exit after that long without any HTTP request. It creates no scheduled task or service and changes no WSL configuration. If DevFlow is already running it just opens the browser.

From WSL: `scripts/devflow-start.sh` / `scripts/devflow-stop.sh` (`DEVFLOW_NO_BROWSER=1` to skip opening a browser). The `.cmd` embeds this machine's distro name and project path; edit those two values if you move the project. Logs go to `logs/devflow.log` (rotated at 1 MiB).

## When data is read

| Trigger | What is read |
|---|---|
| Open the dashboard | Everything, unless the server's cached data is younger than `staleAfterMinutes` (default 5) |
| Navigating between views | Nothing (derived from the loaded data) |
| **Refresh** | Everything, bypassing caches (min. 5 s apart) |
| Open an issue | Only that issue (description + fields) and its linked PRs' checks/reviews, if missing or older than the stale threshold. Other projects/repos are not touched |
| Tab becomes visible again | Re-read only if the data is older than the stale threshold |

Data age is shown in the header; data older than the threshold is badged *stale* but never refreshed automatically. List queries omit issue descriptions; they are fetched per issue.
Checks and reviews are treated as refreshable evidence even when the head SHA is unchanged (checks can be re-run, reviews dismissed): they are cached for at most 15 s (pending) / 2 min (settled), and Refresh bypasses the cache entirely.

## Credentials (dedicated, read-only, env only)

| Variable | Minimum access |
|---|---|
| `LINEAR_API_KEY` | Personal API key, permission **Read** |
| `LINEAR_WRITE_API_KEY` (optional) | A *separate* Linear personal API key, permission **Write**, limited to the configured team(s). Enables the action menu. Must differ from `LINEAR_API_KEY` or write stays disabled. |
| `GITHUB_TOKEN` | Fine-grained PAT limited to the configured repos, all **Read-only**: Metadata, Pull requests, Contents, Actions (and Commit statuses if available) |

DevFlow never uses the `gh` CLI or any ambient identity. Tokens stay on the server: not sent to the browser, not logged, never in error text (upstream error bodies are not forwarded). `.env` and `devflow.config.json` are git-ignored; DevFlow warns at startup if `.env` is readable by other users. `PORT`/`HOST` in `.env` are ignored.
CI evidence comes from GitHub Actions workflow runs for the PR's head commit. Check-run details (individual checks) need a permission this token setup does not expose, so they are shown as **Unavailable**, never as Passed; DevFlow does not ask for it. If a commit has no workflow run, its CI is **Unknown**.

## Teams → Projects

DevFlow discovers every Linear team the read key can see (nothing is hard-coded) and shows **Team › Project** selectors in the header. *All teams* shows whatever is loaded; a team shows **all** of its issues, including ones outside any project; a project shows only its issues; *No project* shows only unprojected issues. Overview, Milestones & Tasks, Pipeline, Activity, label filters, source links and issue details are all scoped to the selection, and switching team or project discards the open ticket, panels and per-view filters.

Teams named in config are read when the dashboard opens; any other accessible team is read **only when you first select it** (`GET /api/team/<KEY>`; other teams, projects and repositories are not touched). Labels are team labels plus applicable workspace labels, with Linear's own names and colors. Milestones stay per project, with a "No milestone" group per project and a separate "Not in a project" group for unprojected issues. Projects and teams without a GitHub repository are fine: they simply show no PR/CI evidence. A GitHub PR links to an issue only if **that issue's own project or team lists the PR's repository**.

**Policy and write authorization are resolved by the server from the issue's live team/project and your config, never from the browser's selection:**

| Issue is in… | Policy | Writes |
|---|---|---|
| a Linear project covered by a `projects[]` entry (it names the project, or its `linear.projects` is empty = every project of the team) | that project's `workflow` | authorized |
| any other project, or no project | the team's `teams[]` entry if it has a `workflow` (explicit policy); otherwise none | only if `teams[].write` is `true` |
| a team with no `teams[]` entry | none (generic defaults for display only) | refused |

Approving for execution requires an **explicit** policy for the exact scope; unprojected issues never inherit a project's rules. Per-team entries look like:

```json
"teams": [{ "key": "ABC", "write": true, "workflow": { "readyLabel": "Ready", "readiness": { "minDescriptionChars": 40 } }, "github": { "repos": ["org/repo"] } }]
```

**Migrating an existing config:** nothing breaks. `projects[]` entries keep working unchanged (their issues keep their rules, repos and write access). What changes: issues **outside** the covered projects (unprojected issues, other projects) are now visible, read-only, and do not inherit the project's workflow; add a `teams[]` entry (with `write: true` and a `workflow`) to enable approval/edits for them.

## Controlled Linear actions (optional)

With a separate **`LINEAR_WRITE_API_KEY`** (a different personal API key from `LINEAR_API_KEY`, permission *Write*, access limited to the configured team(s)), each issue card and the detail panel get an **Actions** menu:

| Action | Rules |
|---|---|
| Edit labels | Add/remove ordinary labels (atomic add/remove: other labels are never replaced). Group labels and **protected workflow labels (the Ready label)** cannot be edited here. |
| Change status | Only allowed transitions: starting work needs approval; **Done needs a merged linked PR** (verified from GitHub); cancel and reopening are done in Linear; a Ready issue cannot be dropped to Backlog without revoking readiness. |
| Set milestone | Only milestones of the issue's own Linear project; can be removed. |
| **Approve for execution** | Checks the project's readiness policy against live Linear (state, Ready label exists, description, unresolved dependencies fully verified, optional milestone/priority/classification). Needs typed confirmation. Then moves to **Todo + Ready**, records an approval comment (who/when/checks) in Linear, re-reads Linear and verifies; rolls back if any step fails or the evidence cannot be confirmed. If a prerequisite cannot be verified, approval is refused and the failed checks are shown. |
| Revoke readiness | Removes Ready, returns an unstarted issue to Backlog, records the revocation, verifies. Started work is refused. |

Without the write key, or for a team/project that config does not authorize, every action stays visible but disabled, with the reason. DevFlow never merges PRs, deletes or bulk-edits issues, starts agents, or writes to GitHub. Every action re-reads the issue, team labels and states from live Linear before acting; it never trusts cached data or browser-supplied names.

**Security model:** POST is accepted only under `/api/actions/`, only from the loopback host, only with an exact same-origin `Origin`, `Sec-Fetch-Site: same-origin` (when sent), `Content-Type: application/json`, a per-process secret CSRF token, and a body under 8 KiB. The Linear write client can send exactly five fixed operations (`issueAddLabel`, `issueRemoveLabel`, `issueUpdate` limited to `stateId`/`projectMilestoneId`, `commentCreate`, `viewer`); the read key cannot write. Writes are serialized. Residual risk: any process running as a local user on this machine can reach `127.0.0.1:4317`, obtain the token and use the write capability, as with any local service; keep the write key off if that is unacceptable.

## Lifecycle stages

**Backlog → Discovery → Ready → Implementation → CI → Independent Review → Human Merge → Done**, derived from real Linear state and labels plus verified GitHub evidence. *Discovery* = a backlog/triage/Todo issue carrying one of the project's `discoveryLabels`; plain backlog issues are **Backlog**, not Discovery. *Ready* requires **both** an unstarted (Todo) state **and** the Ready label (a Todo issue without the label is "not authorized" and stays in Backlog). Classification labels (Idea, Bug, Security, Feature, Research, Tech Debt…) are shown as labels and filterable but are never stages. All label/state names are per-project configuration (`workflow` below), not code.

## Configuration (`devflow.config.json`)

See `devflow.config.example.json`. Per project: `linear.teamKey` (+ optional `linear.projects`), `github.repos`, `knowledge` (Obsidian path, repo file, or URL). Per project `workflow` (all optional; defaults shown in the example): `readyLabel`, `discoveryLabels`, `classificationLabels`, `protectedLabels`, `todoState`, `backlogState`, and the `readiness` policy used by *Approve for execution*. Top level: `staleAfterMinutes`, `staleDays`, `idleExitMinutes`, `obsidian.vault`/`vaultPath`, `prompts` (`{{project}}`, `{{ticket}}`, `{{milestone}}`), `review`.

**Independent review (Codex) evidence** is never assumed: it is *Passed* only if you configure where it is recorded (`review.checkName`, `review.passedLabel`, `review.findingsLabel`); otherwise *Unknown*.

## How things are decided

- **Ticket↔PR link**: only explicit evidence (identifier in branch or PR title, Linear GitHub attachment, Linear `branchName`). Several tickets or none known → *ambiguous* / *unlinked*, never guessed.
- **Status values**: Passed / Failed / Pending / Unknown / N/A with the evidence source. Cancelled/stale checks, truncated lists (over 300 items) and unreadable statuses make CI *Unknown*, never *Passed*; incomplete review lists likewise.
- **Stage** = furthest lifecycle stage with evidence; failing CI or review findings put it back in Implementation (↺).
- **Milestone progress** = completed / (issues − canceled), from real Linear states.
- **Failures**: per-source health; the last good data stays visible, marked stale. A rate limit on one source pauses the whole credential until reset (honouring `Retry-After` and GitHub secondary limits, capped at 1 h).

## Security notes

Only `GET`/`HEAD` are served (others → 405); non-loopback `Host` headers are rejected. The Linear client sends only `query` operations; the GitHub client only `GET /repos/…`. Every upstream call has one deadline that also covers the body read, and bodies are capped at 8 MiB. Only `https` URLs from APIs are rendered as links; descriptions render as text. The static file server is a small built-in handler restricted to `dist/` (it replaced `@fastify/static`, whose `glob`/`minimatch` advisories no longer apply). `npm audit`: 0 vulnerabilities.

## Limitations

- The action menu was tested against an in-memory fake Linear and against live Linear's read-only schema/queries; **no write has been sent to real Linear** (write key not configured).
- Linear exposes no milestone URL; "Edit in Linear" opens the project.
- GitHub: newest 100 PRs per repo; full evidence for open PRs and PRs updated in the last 14 days (max 30), up to 300 items per resource.
- Descriptions over 10,000 characters are cut and marked as truncated.
- Linear history shows state transitions only (last 5 per issue).
- Closing the browser tab does not stop the server; close the launcher window or run `scripts/devflow-stop.sh`.
