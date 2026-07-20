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
6. `pull_request.opened` starts one separate reviewer lifecycle.
7. A separate reviewer GitHub App submits a native `APPROVED` or `CHANGES_REQUESTED` review.
8. A native change request from that reviewer App wakes the developer at the reviewed head SHA.
9. `pull_request.synchronize` coalesces the latest revision into the reviewer lifecycle.
10. A merged `pull_request.closed` event terminally completes both independent lifecycles.

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

## Durable Reviewer Continuations

Durable wake bindings consume active waits atomically during normal event
admission. GitHub PR events provide safe repository ID plus pull request number
correlation. A PR opened event creates one reviewer lifecycle. Synchronize
events received while its turn is queued or running are durably coalesced, and
the latest event's exact head SHA becomes the next immutable turn workspace.
A merged close event dominates pending synchronize events and completes the
lifecycle after the current fenced turn reaches a successful boundary.

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

pull_request.synchronize or issue_comment.created
  -> wake the reviewer wait correlated by repository ID and PR number

pull_request.closed
  -> cancel all active waits for that correlation key
```

The developer and reviewer use separate GitHub Apps. The developer App authors
branches and pull requests; the reviewer App submits native reviews through a
broker token with read-only code access. The reviewer App uses its own
installation, private key, logical `github-reviewer` connection, and broker
credential Secret. The native
change-request wake filters on its stable numeric bot user ID so unrelated human
or bot reviews cannot resume the developer lifecycle. Repository protection may
still allow an eligible human approval to satisfy the merge requirement.

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
