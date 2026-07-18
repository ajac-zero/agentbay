import { z } from "zod";
import { normalizedCloudEventSchema, type NormalizedCloudEvent } from "../../execution/events.js";

const BODY_LIMIT_BYTES = 16 * 1024;
const supportedActions: Record<GitHubEventName, ReadonlySet<string>> = {
  issues: new Set(["opened", "edited", "closed", "reopened", "assigned", "unassigned", "labeled", "unlabeled"]),
  pull_request: new Set([
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
  ]),
} as const;

const bounded = (limit: number) => z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= limit);
const id = z.number().int().safe().nonnegative();
const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const nullableTimestamp = timestamp.nullable();
const fullName = bounded(255).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]+$/);
const sha = z.string().regex(/^[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase());

const actorSchema = z.object({
  id,
  login: bounded(255),
  type: bounded(64),
});

const labelSchema = z.object({ name: bounded(255) });

const repositorySchema = z.object({
  id,
  full_name: fullName,
  clone_url: bounded(2_048),
  default_branch: bounded(255),
  private: z.boolean(),
});

const gitRepositorySchema = z.object({
  id,
  full_name: fullName,
  clone_url: bounded(2_048),
});

const issueSchema = z.object({
  number: z.number().int().positive(),
  title: bounded(4_096),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  user: actorSchema,
  labels: z.array(labelSchema).max(1_000),
  assignees: z.array(actorSchema).max(1_000),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: nullableTimestamp,
});

const branchShape = {
  sha,
  ref: bounded(255),
};
const headBranchSchema = z.object({ ...branchShape, repo: gitRepositorySchema.nullable() });
const baseBranchSchema = z.object({ ...branchShape, repo: gitRepositorySchema });

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: bounded(4_096),
  body: z.string().nullable(),
  draft: z.boolean(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  user: actorSchema,
  head: headBranchSchema,
  base: baseBranchSchema,
  labels: z.array(labelSchema).max(1_000),
  assignees: z.array(actorSchema).max(1_000),
  requested_reviewers: z.array(actorSchema).max(1_000),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: nullableTimestamp,
  merged_at: nullableTimestamp,
});

const commonPayloadShape = {
  action: bounded(64),
  installation: z.object({ id }).nullish(),
  repository: repositorySchema,
  sender: actorSchema,
};

const issuesPayloadSchema = z.object({ ...commonPayloadShape, issue: issueSchema });
const pullRequestPayloadSchema = z.object({ ...commonPayloadShape, pull_request: pullRequestSchema });
const envelopeSchema = z.object({ action: bounded(64) });

export type GitHubEventName = "issues" | "pull_request";

export type NormalizeGitHubEventInput = {
  event: GitHubEventName;
  deliveryId: string;
  payloadSha256: string;
  payload: unknown;
};

function cloneUrl(repository: { full_name: string; clone_url: string }): string {
  const canonical = `https://github.com/${repository.full_name}.git`;
  let supplied: URL;
  try {
    supplied = new URL(repository.clone_url);
  } catch {
    throw new Error("GitHub repository clone_url must be a valid URL");
  }
  if (
    supplied.protocol !== "https:"
    || supplied.hostname.toLowerCase() !== "github.com"
    || supplied.username !== ""
    || supplied.password !== ""
    || supplied.search !== ""
    || supplied.hash !== ""
    || supplied.pathname.toLowerCase() !== `/${repository.full_name}.git`.toLowerCase()
  ) throw new Error("GitHub repository clone_url must match its full_name on github.com");
  return canonical;
}

function truncateBody(body: string | null): { body: string | null; bodyTruncated: boolean } {
  if (body === null) return { body: null, bodyTruncated: false };
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= BODY_LIMIT_BYTES) return { body, bodyTruncated: false };

  let end = BODY_LIMIT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { body: bytes.subarray(0, end).toString("utf8"), bodyTruncated: true };
}

function actor(value: z.infer<typeof actorSchema>) {
  return { id: value.id, login: value.login, type: value.type };
}

function actors(values: z.infer<typeof actorSchema>[]) {
  return values.map(actor).sort((left, right) => compareStrings(left.login, right.login) || left.id - right.id);
}

function labels(values: z.infer<typeof labelSchema>[]) {
  return values.map((label) => label.name).sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitBranch(value: z.infer<typeof headBranchSchema>) {
  return {
    sha: value.sha,
    ref: value.ref,
    repository: value.repo === null
      ? null
      : { id: value.repo.id, fullName: value.repo.full_name, cloneUrl: cloneUrl(value.repo) },
  };
}

export function normalizeGitHubEvent(input: NormalizeGitHubEventInput): NormalizedCloudEvent | null {
  const event = z.enum(["issues", "pull_request"]).parse(input.event);
  const action = envelopeSchema.parse(input.payload).action;
  if (!supportedActions[event].has(action)) return null;

  const payload = event === "issues" ? issuesPayloadSchema.parse(input.payload) : pullRequestPayloadSchema.parse(input.payload);
  if (payload.action !== action) throw new Error("GitHub payload action changed during normalization");

  const repository = {
    id: payload.repository.id,
    fullName: payload.repository.full_name,
    cloneUrl: cloneUrl(payload.repository),
    defaultBranch: payload.repository.default_branch,
    private: payload.repository.private,
  };
  const common = {
    schemaVersion: 1,
    deliveryId: z.string().min(1).max(1_024).parse(input.deliveryId),
    action,
    installationId: payload.installation?.id ?? null,
    repository,
    sender: actor(payload.sender),
  };

  let subject: string;
  const data = event === "issues"
    ? (() => {
        const issue = (payload as z.infer<typeof issuesPayloadSchema>).issue;
        subject = `issues/${issue.number}`;
        return {
          ...common,
          issue: {
            number: issue.number,
            title: issue.title,
            ...truncateBody(issue.body),
            state: issue.state,
            user: actor(issue.user),
            labels: labels(issue.labels),
            assignees: actors(issue.assignees),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            closedAt: issue.closed_at,
          },
        };
      })()
    : (() => {
        const pullRequest = (payload as z.infer<typeof pullRequestPayloadSchema>).pull_request;
        subject = `pulls/${pullRequest.number}`;
        return {
          ...common,
          pullRequest: {
            number: pullRequest.number,
            title: pullRequest.title,
            ...truncateBody(pullRequest.body),
            draft: pullRequest.draft,
            state: pullRequest.state,
            merged: pullRequest.merged,
            user: actor(pullRequest.user),
            head: gitBranch(pullRequest.head),
            base: gitBranch(pullRequest.base),
            labels: labels(pullRequest.labels),
            assignees: actors(pullRequest.assignees),
            requestedReviewers: actors(pullRequest.requested_reviewers),
            createdAt: pullRequest.created_at,
            updatedAt: pullRequest.updated_at,
            closedAt: pullRequest.closed_at,
            mergedAt: pullRequest.merged_at,
          },
        };
      })();

  return normalizedCloudEventSchema.parse({
    specversion: "1.0",
    id: common.deliveryId,
    source: `https://github.com/${repository.fullName}`,
    type: `com.github.${event}.${action}`,
    subject,
    datacontenttype: "application/json",
    githubevent: event,
    githubpayloadsha256: z.string().regex(/^[0-9a-f]{64}$/).parse(input.payloadSha256),
    data,
  });
}
