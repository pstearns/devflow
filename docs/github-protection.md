# GitHub protection for DevFlow's `main`

DevFlow's controller can only ever push `devflow/<ticket>-<run>` branches and open **draft** PRs (enforced in code), but code is not the last line of
defence: the write token itself can push anywhere its permissions allow. A repository ruleset is what makes `main` unreachable for it.

## Ruleset (apply with an ADMIN credential; DevFlow never applies it)

`docs/github-ruleset-main.json` is the exact body. It has no bypass actors, so neither the DevFlow write token nor an admin can push to `main`
directly; the owner merges through a pull request.

| Rule | Why |
|---|---|
| `deletion`, `non_fast_forward` | `main` cannot be deleted or force-pushed by any token |
| `pull_request` (0 required approvals, threads resolved, stale reviews dismissed) | every change reaches `main` through a PR. 0 approvals because a sole owner cannot approve their own PR on GitHub; the merge click *is* the owner approval. Raise it if you add reviewers |
| `required_status_checks`: `verify` (strict) | the CI job in `.github/workflows/ci.yml` must be green on the PR head, up to date with `main` |

Apply (needs a credential with *Administration: write* on the repository; run it yourself):

```bash
gh api -X POST repos/pstearns/devflow/rulesets --input docs/github-ruleset-main.json
gh api repos/pstearns/devflow/rulesets --jq '.[] | {id,name,enforcement}'   # verify it is active
```

To confirm it holds, with the DevFlow write token a push to `main` must now be rejected (`GH013: Repository rule violations`).

## The two tokens (fine-grained PATs, repository `pstearns/devflow` only)

| Token | Variable | Permissions | Used for |
|---|---|---|---|
| read | `GITHUB_TOKEN` | Metadata, Contents, Pull requests, Actions, **Commit statuses**: all *Read* | dashboard reads; the orchestrator's CI / PR-head polling |
| write | `GITHUB_WRITE_TOKEN` | Contents: *Write*, Pull requests: *Write*, Metadata: Read, and **Workflows: Write only while a workflow file must be pushed** | the controller's `git push` of `devflow/*` branches and creating draft PRs |

Agents receive neither. The read token never creates a PR and never pushes; the write token is never used for reads of CI. `GITHUB_WRITE_TOKEN` must
differ from `GITHUB_TOKEN` (the CLI refuses otherwise). Do not grant Administration, Secrets, Actions-write or Environments to either token.
