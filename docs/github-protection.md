# GitHub protection for DevFlow's `main`

DevFlow's controller can only ever push `devflow/<ticket>-<run>` branches and open **draft** PRs (enforced in code), but code is not the last line of
defence: the write token itself can push anywhere its permissions allow. A repository ruleset is what makes `main` unreachable for it.

## Ruleset (apply with an ADMIN credential; DevFlow never applies it)

`docs/github-ruleset-main.json` is the exact body. Only the repository **Admin** role can bypass, and only *through a pull request*, so nobody can push to
`main` directly, force-push it or delete it; every change needs a PR with a green `verify`; and non-admin identities cannot update `main` at all (the `update` rule),
which includes merging a PR.

| Rule | Why |
|---|---|
| `update` (admins may bypass only via a PR) | identities without the Admin role cannot move `main`, so they cannot merge a PR either |
| `deletion`, `non_fast_forward` | `main` cannot be deleted or force-pushed by any token |
| `pull_request` (0 required approvals, threads resolved, stale reviews dismissed) | every change reaches `main` through a PR. 0 approvals because a sole owner cannot approve their own PR on GitHub; the merge click *is* the owner approval. Raise it if you add reviewers |
| `required_status_checks`: `verify` (strict) | the CI job in `.github/workflows/ci.yml` must be green on the PR head, up to date with `main` |

Apply (needs a credential with *Administration: write* on the repository; run it yourself):

```bash
gh api -X POST repos/pstearns/devflow/rulesets --input docs/github-ruleset-main.json
gh api repos/pstearns/devflow/rulesets --jq '.[] | {id,name,enforcement}'   # verify it is active
```

To confirm it holds, with the DevFlow write token a push to `main` must now be rejected (`GH013: Repository rule violations`).

## Who can merge: the one thing a ruleset cannot fix for a PAT you own

GitHub's merge API needs the same *Contents: write* the controller needs to push. A fine-grained PAT acts as the user who created it. If that user is the
repository Admin (as `pstearns` is), the PAT inherits the Admin bypass, so a holder of the DevFlow write token could in principle open a **non-draft** PR,
wait for `verify`, and merge it, with no owner involved. DevFlow's code never does this (the PR client can only create drafts; there is no ready/merge method;
tests assert it), but the *credential* could.

To make "only the owner merges" a property of GitHub rather than of DevFlow's code, the DevFlow write token must belong to **a separate account with the
Write role (not Admin)**: a machine user added as a collaborator, or a GitHub App. With the ruleset above that identity can push `devflow/*` branches and open
draft PRs but cannot update `main`. Until that exists, treat the write token as able to merge and keep it out of everything except the controller. This is
recorded as an open risk for owner decision.

## The two tokens (fine-grained PATs, repository `pstearns/devflow` only)

| Token | Variable | Permissions | Used for |
|---|---|---|---|
| read | `GITHUB_TOKEN` | Metadata, Contents, Pull requests, Actions, **Commit statuses**: all *Read* | dashboard reads; the orchestrator's CI / PR-head polling |
| write | `GITHUB_WRITE_TOKEN` | Contents: *Write*, Pull requests: *Write*, Metadata: Read, and **Workflows: Write only while a workflow file must be pushed** | the controller's `git push` of `devflow/*` branches and creating draft PRs |

Agents receive neither. The read token never creates a PR and never pushes; the write token is never used for reads of CI. `GITHUB_WRITE_TOKEN` should be issued to the machine account described above and must
differ from `GITHUB_TOKEN` (the CLI refuses otherwise). Do not grant Administration, Secrets, Actions-write or Environments to either token.
