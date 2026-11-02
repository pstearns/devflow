# DevFlow

Read-only, local-first dashboard over **Linear** (GraphQL) and **GitHub** (REST): pipeline, milestones & tasks, PRs/CI/review evidence, activity, attention queue, prompt library, project knowledge links.

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
| `GITHUB_TOKEN` | Fine-grained PAT limited to the configured repos, all **Read-only**: Metadata, Pull requests, Contents, Actions, **Checks**, **Commit statuses** |

DevFlow never uses the `gh` CLI or any ambient identity. Tokens stay on the server: not sent to the browser, not logged, never in error text (upstream error bodies are not forwarded). `.env` and `devflow.config.json` are git-ignored; DevFlow warns at startup if `.env` is readable by other users. `PORT`/`HOST` in `.env` are ignored.
Without Checks/Commit-statuses permission DevFlow still works: it names the missing permission in *Integration health* and uses Actions workflow runs as labelled fallback CI evidence.

## Configuration (`devflow.config.json`)

See `devflow.config.example.json`. Per project: `linear.teamKey` (+ optional `linear.projects`), `github.repos`, `knowledge` (Obsidian path, repo file, or URL). Top level: `staleAfterMinutes`, `staleDays`, `idleExitMinutes`, `obsidian.vault`/`vaultPath`, `prompts` (`{{project}}`, `{{ticket}}`, `{{milestone}}`), `review`.

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

- Linear exposes no milestone URL; "Edit in Linear" opens the project.
- GitHub: newest 100 PRs per repo; full evidence for open PRs and PRs updated in the last 14 days (max 30), up to 300 items per resource.
- Descriptions over 10,000 characters are cut and marked as truncated.
- Linear history shows state transitions only (last 5 per issue).
- Closing the browser tab does not stop the server; close the launcher window or run `scripts/devflow-stop.sh`.
