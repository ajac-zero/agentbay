import { describe, expect, it } from "vitest";
import { normalizeGitHubEvent } from "../../src/connectors/github/normalize.js";

const actor = (id: number, login: string) => ({ id, login, type: "User", ignored: true });
const repository = (fullName = "acme/widgets") => ({
  id: 10,
  full_name: fullName,
  clone_url: `https://github.com/${fullName}.git`,
  default_branch: "main",
  private: false,
  owner: actor(1, "owner"),
});
const common = {
  action: "opened",
  installation: { id: 44 },
  repository: repository(),
  sender: actor(2, "sender"),
  unknown: { large: "not projected" },
};
const issue = {
  id: 700,
  number: 7,
  title: "Bug",
  body: "Details",
  state: "open",
  user: actor(3, "author"),
  labels: [{ name: "zeta" }, { name: "alpha" }],
  assignees: [actor(5, "zoe"), actor(4, "amy")],
  created_at: "2026-07-01T10:00:00Z",
  updated_at: "2026-07-02T10:00:00+00:00",
  closed_at: null,
  ignored: "value",
};
const branch = (fullName: string, value: string) => ({
  sha: value,
  ref: "feature",
  repo: { ...repository(fullName), extra: true },
});

const input = (payload: unknown, event: "issues" | "issue_comment" | "pull_request" | "pull_request_review" | "pull_request_review_comment" | "workflow_run" = "issues") => ({
  event,
  deliveryId: "delivery-1",
  payloadSha256: "a".repeat(64),
  payload,
});

describe("normalizeGitHubEvent", () => {
  it("normalizes an issue into a compact deterministic V1 event", () => {
    const event = normalizeGitHubEvent(input({ ...common, issue }));
    expect(event).toMatchObject({
      id: "delivery-1",
      source: "https://github.com/acme/widgets",
      type: "com.github.issues.opened",
      subject: "issues/7",
      githubevent: "issues",
      githubpayloadsha256: "a".repeat(64),
      data: {
        schemaVersion: 1,
        deliveryId: "delivery-1",
        action: "opened",
        installationId: 44,
        repository: { id: 10, fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", defaultBranch: "main", private: false },
        sender: { id: 2, login: "sender", type: "User" },
        issue: {
          number: 7,
          body: "Details",
          bodyTruncated: false,
          labels: ["alpha", "zeta"],
          assignees: [{ id: 4, login: "amy", type: "User" }, { id: 5, login: "zoe", type: "User" }],
          createdAt: "2026-07-01T10:00:00.000Z",
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain("not projected");
    expect(JSON.stringify(event)).not.toContain("ignored");
  });

  it("uses and validates the fork head repository for pull request workspaces", () => {
    const pullRequest = {
      ...issue,
      draft: false,
      merged: false,
      head: branch("contributor/widgets", "A".repeat(40)),
      base: branch("acme/widgets", "b".repeat(40)),
      requested_reviewers: [actor(8, "reviewer")],
      merged_at: null,
    };
    const event = normalizeGitHubEvent(input({ ...common, pull_request: pullRequest }, "pull_request"));
    expect(event).toMatchObject({
      type: "com.github.pull_request.opened",
      subject: "pulls/7",
      data: {
        pullRequest: {
          head: { sha: "a".repeat(40), repository: { fullName: "contributor/widgets", cloneUrl: "https://github.com/contributor/widgets.git" } },
          base: { sha: "b".repeat(40), repository: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" } },
          requestedReviewers: [{ id: 8, login: "reviewer", type: "User" }],
        },
      },
    });
  });

  it("preserves the exact head revision when a closed pull request fork was deleted", () => {
    const pullRequest = {
      ...issue,
      state: "closed",
      draft: false,
      merged: false,
      head: { ...branch("contributor/widgets", "c".repeat(40)), ref: "deleted-fork-branch", repo: null },
      base: { ...branch("acme/widgets", "b".repeat(40)), ref: "main" },
      requested_reviewers: [],
      closed_at: "2026-07-03T10:00:00Z",
      merged_at: null,
    };
    const event = normalizeGitHubEvent(input({ ...common, action: "closed", pull_request: pullRequest }, "pull_request"));

    expect(event).toMatchObject({
      type: "com.github.pull_request.closed",
      data: {
        action: "closed",
        pullRequest: {
          state: "closed",
          head: { sha: "c".repeat(40), ref: "deleted-fork-branch", repository: null },
          base: { sha: "b".repeat(40), ref: "main", repository: { fullName: "acme/widgets" } },
        },
      },
    });
  });

  it("normalizes issue comments with current labels for routing", () => {
    const event = normalizeGitHubEvent(input({
      ...common,
      action: "created",
      issue: { ...issue, labels: [{ name: "agentbay/state:ready" }, { name: "agentbay/difficulty:hard" }] },
      comment: {
        id: 91,
        body: "Please continue",
        user: actor(9, "maintainer"),
        created_at: "2026-07-03T10:00:00Z",
        updated_at: "2026-07-03T10:01:00Z",
      },
    }, "issue_comment"));

    expect(event).toMatchObject({
      type: "com.github.issue_comment.created",
      subject: "issues/7",
      data: {
        issue: { labels: ["agentbay/difficulty:hard", "agentbay/state:ready"] },
        comment: { id: 91, body: "Please continue", bodyTruncated: false, user: { login: "maintainer" } },
      },
    });
  });

  it("normalizes native pull request review states independently of body syntax", () => {
    const pullRequest = {
      ...issue,
      draft: false,
      merged: false,
      head: branch("contributor/widgets", "a".repeat(40)),
      base: branch("acme/widgets", "b".repeat(40)),
      requested_reviewers: [],
      merged_at: null,
    };
    const review = normalizeGitHubEvent(input({
      ...common,
      action: "submitted",
      pull_request: pullRequest,
      review: {
        id: 92,
        body: "Needs changes",
        user: actor(8, "reviewer"),
        state: "CHANGES_REQUESTED",
        commit_id: "a".repeat(40),
        submitted_at: "2026-07-03T11:00:00Z",
      },
    }, "pull_request_review"));
    expect(review).toMatchObject({
      type: "com.github.pull_request_review.submitted",
      subject: "pulls/7",
      data: { review: { id: 92, state: "changes_requested", commitSha: "a".repeat(40) } },
    });
    expect(review).not.toHaveProperty("data.review.agentbayVerdict");

    expect(normalizeGitHubEvent(input({
      ...common,
      action: "submitted",
      pull_request: pullRequest,
      review: {
        id: 93,
        body: "Looks good",
        user: actor(9, "reviewer-app[bot]"),
        state: "APPROVED",
        commit_id: "a".repeat(40),
        submitted_at: "2026-07-03T11:01:00Z",
      },
    }, "pull_request_review"))).toMatchObject({
      data: { review: { id: 93, state: "approved", user: { id: 9, login: "reviewer-app[bot]" } } },
    });

    const { merged: _merged, ...reviewPullRequest } = pullRequest;
    const appReviewPayload = {
      ...common,
      action: "submitted",
      pull_request: reviewPullRequest,
      review: {
        id: 94,
        body: "Agentbay-Verdict: approved\n\nNo issues found.",
        user: actor(9, "factory[bot]"),
        state: "commented",
        commit_id: "a".repeat(40),
        submitted_at: "2026-07-03T11:01:00Z",
      },
    };
    expect(normalizeGitHubEvent(input(appReviewPayload, "pull_request_review"))).toMatchObject({
      data: {
        pullRequest: { merged: false },
        review: { state: "commented", agentbayVerdict: "approved" },
      },
    });
    expect(normalizeGitHubEvent(input({
      ...appReviewPayload,
      review: { ...appReviewPayload.review, body: "Summary\nAgentbay-Verdict: changes_requested" },
    }, "pull_request_review"))).not.toHaveProperty("data.review.agentbayVerdict");

    const comment = normalizeGitHubEvent(input({
      ...common,
      action: "created",
      pull_request: pullRequest,
      comment: {
        id: 93,
        body: "Handle this edge case",
        user: actor(8, "reviewer"),
        path: "src/index.ts",
        line: 12,
        original_line: 10,
        side: "RIGHT",
        commit_id: "a".repeat(40),
        in_reply_to_id: 90,
        created_at: "2026-07-03T11:01:00Z",
        updated_at: "2026-07-03T11:01:00Z",
      },
    }, "pull_request_review_comment"));
    expect(comment).toMatchObject({
      type: "com.github.pull_request_review_comment.created",
      subject: "pulls/7",
      data: { comment: { id: 93, path: "src/index.ts", line: 12, inReplyToId: 90, commitSha: "a".repeat(40) } },
    });
  });

  it("returns null for unsupported actions", () => {
    expect(normalizeGitHubEvent(input({ action: "deleted" }))).toBeNull();
  });

  it("normalizes one completed pull request workflow run at its exact head SHA", () => {
    const event = normalizeGitHubEvent(input({
      ...common,
      action: "completed",
      workflow_run: {
        id: 900,
        name: "CI",
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        head_sha: "a".repeat(40),
        head_branch: "feature",
        head_repository: repository("contributor/widgets"),
        pull_requests: [{
          id: 700,
          number: 7,
          head: { ref: "feature", sha: "a".repeat(40) },
          base: { ref: "main", sha: "b".repeat(40) },
        }],
      },
    }, "workflow_run"));

    expect(event).toMatchObject({
      type: "com.github.workflow_run.completed",
      subject: "pulls/7",
      data: {
        pullRequest: {
          id: 700,
          number: 7,
          head: { sha: "a".repeat(40), repository: { fullName: "contributor/widgets" } },
          base: { ref: "main", sha: "b".repeat(40) },
        },
        workflowRun: { id: 900, name: "CI", event: "pull_request", status: "completed", conclusion: "success", headSha: "a".repeat(40) },
      },
    });
  });

  it("ignores workflow runs without exactly one matching pull request head", () => {
    const payload = {
      ...common,
      action: "completed",
      workflow_run: {
        id: 900, name: "CI", event: "pull_request", status: "completed", conclusion: "success",
        head_sha: "a".repeat(40), head_branch: "feature", head_repository: repository(), pull_requests: [],
      },
    };
    expect(normalizeGitHubEvent(input(payload, "workflow_run"))).toBeNull();
    expect(normalizeGitHubEvent(input({ ...payload, workflow_run: { ...payload.workflow_run, pull_requests: [{
      id: 700, number: 7, head: { ref: "feature", sha: "c".repeat(40) }, base: { ref: "main", sha: "b".repeat(40) },
    }] } }, "workflow_run"))).toBeNull();
  });

  it.each([
    "opened",
    "edited",
    "closed",
    "reopened",
    "assigned",
    "unassigned",
    "labeled",
    "unlabeled",
  ])("supports the issues %s action", (action) => {
    expect(normalizeGitHubEvent(input({ ...common, action, issue }))?.type).toBe(`com.github.issues.${action}`);
  });

  it.each([
    "opened",
    "edited",
    "closed",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
    "review_requested",
    "review_request_removed",
    "assigned",
    "unassigned",
    "labeled",
    "unlabeled",
  ])("supports the pull_request %s action", (action) => {
    const pullRequest = {
      ...issue,
      draft: false,
      merged: false,
      head: branch("contributor/widgets", "a".repeat(40)),
      base: branch("acme/widgets", "b".repeat(40)),
      requested_reviewers: [],
      merged_at: null,
    };
    expect(normalizeGitHubEvent(input({ ...common, action, pull_request: pullRequest }, "pull_request"))?.type)
      .toBe(`com.github.pull_request.${action}`);
  });

  it("rejects malformed supported payloads, SHAs, and non-GitHub clone URLs", () => {
    expect(() => normalizeGitHubEvent(input({ ...common, issue: { ...issue, number: "7" } }))).toThrow();
    const pullRequest = {
      ...issue,
      draft: false,
      merged: false,
      head: branch("contributor/widgets", "short"),
      base: branch("acme/widgets", "b".repeat(40)),
      requested_reviewers: [],
      merged_at: null,
    };
    expect(() => normalizeGitHubEvent(input({ ...common, pull_request: pullRequest }, "pull_request"))).toThrow();
    expect(() => normalizeGitHubEvent(input({
      ...common,
      action: "closed",
      pull_request: { ...pullRequest, head: { ref: "deleted-fork", repo: null } },
    }, "pull_request"))).toThrow();
    expect(() => normalizeGitHubEvent(input({
      ...common,
      action: "closed",
      pull_request: { ...pullRequest, head: { sha: "a".repeat(40), repo: null } },
    }, "pull_request"))).toThrow();
    expect(() => normalizeGitHubEvent(input({
      ...common,
      pull_request: { ...pullRequest, head: branch("contributor/widgets", "a".repeat(40)), base: { ...pullRequest.base, repo: null } },
    }, "pull_request"))).toThrow();
    expect(() => normalizeGitHubEvent(input({ ...common, repository: { ...repository(), clone_url: "https://example.com/acme/widgets.git" }, issue }))).toThrow(/github.com/);
  });

  it("truncates bodies deterministically at a UTF-8 boundary", () => {
    const body = `${"x".repeat(16 * 1024 - 1)}😀suffix`;
    const event = normalizeGitHubEvent(input({ ...common, issue: { ...issue, body } }));
    const normalizedIssue = (event!.data as { issue: { body: string; bodyTruncated: boolean } }).issue;
    expect(Buffer.byteLength(normalizedIssue.body, "utf8")).toBe(16 * 1024 - 1);
    expect(normalizedIssue.body.endsWith("�")).toBe(false);
    expect(normalizedIssue.bodyTruncated).toBe(true);
  });
});
