import { createRoute, z } from "@hono/zod-openapi";
import { simpleIdSchema } from "../../execution/api-schema.js";

const errorSchema = z.object({ error: z.string().min(1) }).strict();
const deliverySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const eventSchema = z.string().regex(/^(?=.{1,128}$)[a-z]+(?:_[a-z]+)*$/);
const signatureSchema = z.string().regex(/^sha256=[0-9a-f]{64}$/);
const contentTypeSchema = z.string().regex(/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/);

export const githubWebhookRoute = createRoute({
  method: "post",
  path: "/hooks/github/{triggerID}",
  tags: ["webhooks"],
  summary: "Receive a GitHub App webhook",
  security: [],
  request: {
    params: z.object({ triggerID: simpleIdSchema }),
    headers: z.object({
      "Content-Type": contentTypeSchema.openapi({ example: "application/json; charset=utf-8" }),
      "X-GitHub-Delivery": deliverySchema,
      "X-GitHub-Event": eventSchema,
      "X-Hub-Signature-256": signatureSchema.openapi({ example: `sha256=${"0".repeat(64)}` }),
    }),
    body: {
      required: true,
      // A plain OpenAPI schema documents the body without parsing it before signature verification.
      content: { "application/json": { schema: { type: "object", additionalProperties: true } as never } },
    },
  },
  responses: {
    202: { description: "Webhook admitted or idempotently replayed." },
    204: { description: "Signed ping or unsupported webhook accepted without admission." },
    400: jsonError("Malformed headers or JSON object payload."),
    401: jsonError("Webhook authentication failed."),
    404: jsonError("Signed webhook cannot be accepted by the trigger."),
    409: jsonError("Delivery conflicts with an earlier payload."),
    413: jsonError("Request body too large."),
    415: jsonError("Unsupported media type or content encoding."),
    422: jsonError("Workspace could not be resolved from event data."),
    500: jsonError("Internal server error."),
  },
});

function jsonError(description: string) {
  return { description, content: { "application/json": { schema: errorSchema } } };
}
