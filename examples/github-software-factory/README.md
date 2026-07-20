# GitHub Software Factory

This example expresses repository automation as Agentbay configuration rather
than source-specific orchestration code. GitHub is the visible workflow ledger:
the triager applies labels, and immutable bindings select an exact developer
profile from the issue's complete current label set.

## Implemented Slice

The resources in `bindings.yaml` use currently supported create bindings and
the generic `contains` array predicate. They demonstrate:

1. `issues.opened` starts triage.
2. Triage applies one difficulty label and then `agentbay/state:ready`.
3. `issues.labeled` selects exactly one developer profile.
4. All difficulty bindings share an active singleton keyed by repository ID and issue number, so later ready-label deliveries cannot create a second developer lifecycle while the first is nonterminal.
5. The broker attributes the developer's primary PR through a fenced mutation receipt and matching signed webhook.
6. `pull_request.opened` starts CI but does not provision a reviewer sandbox.
7. The canonical `CI` workflow's terminal event starts one one-shot reviewer execution for its exact head SHA.
8. A separate reviewer GitHub App submits a native `APPROVED` or `CHANGES_REQUESTED` review after considering code and CI.
9. A native change request from that reviewer App wakes the developer at the reviewed head SHA.
10. A new push starts CI again; only that revision's terminal workflow event can resume review.
11. An approval from the pinned reviewer App starts a least-privilege merger execution.
12. The merger verifies the reviewed SHA is still the PR head, then asks GitHub to merge through repository protection.
13. A merged `pull_request.closed` event terminally completes the developer lifecycle.

`triggers.yaml` adds a durable hourly `schedule.cron` ingress. Each due time is
materialized in PostgreSQL before the schedule advances, then leased and admitted
through the same event boundary as webhooks. The matching bug-finder audits an
exact resolved default-branch SHA with read-only code access and may create at
most one evidence-backed issue. That `issues.opened` webhook enters step 1 above.
Missed intervals use `skip` semantics, and the repository singleton prevents
overlapping audits without retaining a sandbox between runs.

The binding checkpoint is keyed by stable binding ID and repository ID. A
successful audit atomically advances it to the audited SHA. An unchanged SHA
creates no execution or sandbox; failures retain the previous SHA. Each created
execution receives trusted `previous`, `current`, and `initial` range metadata.

The GitHub connector also normalizes issue comments, pull-request reviews, and
pull-request review comments for later continuation matching.

Replace `acme/agentbay`, profile models, connection IDs, and template names
before publishing these request bodies through the management API.

The profiles name concrete `v1beta1` pools. The supplied Helm values create one
zero-replica pool per role, providing cold-start allocation while satisfying the
native `v1beta1` claim contract.

Issue deliveries are durably ingested before admission. When the developer
binding matches, the revision resolver uses the delivery's installation ID to
mint a selected-repository, contents-read token, verifies repository identity
and the default branch, and persists its exact commit before creating any
execution. The binding selects `/repository/defaultBranchRevision/commit`; it
never uses a mutable branch name.

## Deferred One-Shot Reviews

PR open and synchronize events never create reviewer executions. A terminal
canonical CI workflow event creates a one-shot reviewer for its exact head SHA.
The active singleton key includes repository ID, PR number, and SHA, preventing
concurrent duplicate review executions for one revision. A later revision runs
CI again and creates a distinct one-shot reviewer only after that run completes.
No reviewer SandboxClaim exists while the workflow is queued or running.

The developer and reviewer remain separate executions. The issue-origin
developer context starts with repository ID and an empty supplied PR-number
slot. Only the execution-scoped GitHub broker receipt, verified against the
signed opened webhook's repository ID, PR database ID, and number, can fill that
slot. PR body text and repository-only correlation are never authoritative.

The three developer difficulty bindings use the same `activeSingleton.name`
and key paths. Agentbay admits every distinct signed delivery for audit and
idempotent replay, but suppresses execution creation while a nonterminal
execution owns that singleton. Terminal completion releases the key for a
future delivery.

The reciprocal policy is:

```text
pull_request_review.submitted where review.state=changes_requested
  and review.user.id=<reviewer App bot user ID>
  -> wake the developer wait correlated by repository ID and PR number

pull_request_review.submitted where review.state=approved
  and review.user.id=<reviewer App bot user ID>
  and review.commitSha exists
  -> create a merger execution that validates the current head and calls GitHub's merge API

workflow_run.completed where workflowRun.name=CI
  and workflowRun.headBranch does not start with dependabot/
  -> create a one-shot reviewer execution for repository ID, PR number, and head SHA

verified Dependabot npm patch/minor update
  and only package.json and pnpm-lock.yaml changed
  and CI, Dependency Review, and CodeQL succeeded for the exact head SHA
  -> github-actions[bot] submits an exact-SHA deterministic approval

ineligible Dependabot update after required checks
  -> trusted workflow applies agentbay-review
  -> create the normal one-shot reviewer execution for the exact head SHA

pull_request.closed
  -> complete the developer wait for that correlation key
```

The developer and reviewer use separate GitHub Apps. The developer App authors
branches and pull requests; the reviewer App submits native reviews through a
broker token with read-only code access. The reviewer App uses its own
installation, private key, logical `github-reviewer` connection, and broker
credential Secret. The native
change-request wake filters on its stable numeric bot user ID so unrelated human
or bot reviews cannot resume the developer lifecycle. The merger accepts approvals
only from that reviewer App or the fixed `github-actions[bot]` actor used by the
trusted Dependabot fast lane. Repository protection may still allow an eligible
human approval to satisfy the merge requirement without starting Agentbay's merger.

The wait resource policy should default to `release`; deployments with a
PVC-backed Agent Sandbox may choose `suspend` after claim-owned Sandbox
suspend/resume is validated against the pinned `v1beta1` controller.

## GitHub Labels

- `agentbay/state:ready`
- `agentbay/difficulty:easy`
- `agentbay/difficulty:medium`
- `agentbay/difficulty:hard`

The triager must apply the difficulty label before the final ready label. Each
developer binding requires both, preventing dispatch from an intermediate
label event.

Replaying the `agentbay/state:ready` label while a developer lifecycle is already active does not create another execution or pull request.

## Capabilities

Profiles authorize `github-token-broker`, which injects short-lived,
repository-scoped installation tokens while proxying to the unmodified official
GitHub MCP server. OpenCode denies `github_*` globally and each selected agent
allows only its exact role tools:

| Role | Required GitHub capabilities |
|---|---|
| Triager | Read issue, manage labels, comment |
| Developer | Read issue/PR, create branch, write content, create/update PR, comment |
| Reviewer | Read PR/diff/checks, create review and review comments |
| Merger | Read PR/reviews, merge through repository protection |

The merger uses the developer App installation but runs in its own sandbox. Its
official GitHub MCP exposes only `pull_request_read` and `merge_pull_request`,
and its broker token is narrowed to `contents:write,pull_requests:write`. The
binding accepts only an `approved` native review from the configured reviewer
App actor, and the broker independently requires that actor ID in the execution
capability to match its configured reviewer ID. Before merging, the agent requires the PR's current head to equal the
review's `commitSha`; GitHub then atomically enforces branch protection. A stale
approval, pending required check, merge conflict, or other protection failure
leaves the PR open.

The deployed developer tiers may use distinct models while retaining separate
immutable profiles and a common capability ceiling:

| Difficulty | Model |
|---|---|
| Easy | `gateway/claude-sonnet-5` |
| Medium | `gateway/claude-opus-4-7` |
| Hard | `gateway/claude-fable-5` |

`sandbox-templates.values.yaml` supplies one template per role with only that role's exact official-server
`--tools` allow-list. This is required, not optional: containers in one Pod
share loopback, so OpenCode permissions alone cannot prevent a process from
calling the broker directly. `deploy/examples/sandbox-template.yaml` is the raw
developer-template equivalent. Never place the installation token or App private
key inside OpenCode configuration.

The reviewer template deliberately mounts a different App Secret from the
developer and triager templates. Role tool restrictions are not identity
separation: native GitHub approval requires an identity other than the pull
request author. GitHub counts required approvals only from reviewers with
repository write access. The reviewer App installation therefore needs
`Contents: read and write`, even though the broker deliberately narrows each
reviewer sandbox token back to `contents:read,pull_requests:write,actions:read`.
This preserves native approval eligibility without granting the review agent a
content-writing token.
