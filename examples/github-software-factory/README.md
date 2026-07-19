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
4. `pull_request.opened` and `pull_request.synchronize` start review.

The GitHub connector also normalizes issue comments, pull-request reviews, and
pull-request review comments for later continuation matching.

Replace `acme/agentbay`, profile models, connection IDs, and template names
before publishing these request bodies through the management API.

Issue deliveries are durably ingested before admission. When the developer
binding matches, the revision resolver uses the delivery's installation ID to
mint a selected-repository, contents-read token, verifies repository identity
and the default branch, and persists its exact commit before creating any
execution. The binding selects `/repository/defaultBranchRevision/commit`; it
never uses a mutable branch name.

## Planned Continuations

Durable `EventWait` activation and the `WAITING` execution state are implemented
through immutable binding `afterTurn` policy. The developer binding intentionally
does not enable it yet: an issue-origin execution needs a deterministic PR
identity before it can safely correlate review and merge events. Repository-only
correlation would let one PR wake another execution.

Once wake bindings and deterministic PR identity are implemented, this example
will add the following generic policy:

```text
pull_request_review.submitted where review.state=changes_requested
  -> wake the developer wait correlated by repository ID and PR number

pull_request.synchronize or issue_comment.created
  -> wake the reviewer wait correlated by repository ID and PR number

pull_request.closed
  -> cancel all active waits for that correlation key
```

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
