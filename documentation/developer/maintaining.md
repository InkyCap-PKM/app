# Maintaining the InkyCap repository

Repo-administration runbook for maintainers: the one-time and occasional
settings that keep the project healthy as contributors arrive. This is distinct
from [releasing.md](releasing.md) (how to cut a release) and
[../../CONTRIBUTING.md](../../CONTRIBUTING.md) (the contributor-facing workflow);
it documents the Codeberg/Forgejo configuration that backs them.

## Branch protection

InkyCap is trunk-based: everything lands on `main`, releases are tags, and there
is no `develop` branch (see the "Branching and releases" section of
[CONTRIBUTING.md](../../CONTRIBUTING.md)). Branch protection is what enforces
that model server-side.

Configure under **repo → Settings → Branches → Branch protection rules**,
protecting the branch `main`.

### Enable now (pure upside)

- **Protect `main`.** Protecting the branch blocks force-pushes and branch
  deletion, the two genuinely destructive operations. No reason to wait on this.
- **Restrict push → whitelist maintainers.** Outside contributors then must go
  through pull requests, while maintainers keep the ability to land trivial,
  obviously-safe direct commits (the policy CONTRIBUTING describes). Choose
  "Disable push" instead only if you want every change, including your own, to
  go through a PR.

### Leave off for a solo / very small project

- **Require approvals / reviews.** Keep required approvals at **0**. With a
  single maintainer, requiring approvals blocks your own merges. Turn it on only
  once there is more than one person who can review.
- **Require signed commits.** Codeberg has no key to sign the merge commits it
  creates, and enforcing contributor commit signing adds friction for little
  gain at this stage.
- **Require branch up-to-date before merge.** Unnecessary churn at current
  volume.

### Stage carefully: require status checks

Requiring the CI jobs (`rustfmt`, `clippy`, `rust-test`, `frontend`) to pass
before merge is the highest-value rule in principle: it guarantees `main` stays
green. Do **not** enable it until CI runners are reliably picking up jobs, for
two reasons:

1. If a required check never runs (no available runner), the PR becomes stuck
   and unmergeable.
2. First-time-contributor PRs need manual approval before their CI runs at all
   ("Approve once" on the PR), so the checks will not start on their own.

Until runners are dependable, the maintainer is the enforcement: review plus the
local gates listed in CONTRIBUTING. Switch this rule on once the runner situation
is solid, and it becomes the automated backstop behind "`main` stays green".

### Suggested rollout order

1. **Now:** protect `main` (no force-push, no deletion) and whitelist maintainers
   for push.
2. **When runners are dependable:** add required status checks.
