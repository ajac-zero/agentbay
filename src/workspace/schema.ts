import { z } from "@hono/zod-openapi";
import { jsonPointerSchema } from "../json.js";
import { canonicalizeRepositoryUrl } from "./resolver.js";
import type { BindingWorkspace, ResolvedWorkspace } from "./types.js";

const emptyWorkspaceSchema = z.object({ type: z.literal("empty") }).strict();
const selectorSchema = z.object({ path: jsonPointerSchema }).strict();
const canonicalRepositoryUrlSchema = z.string().superRefine((value, context) => {
  try {
    if (canonicalizeRepositoryUrl(value) !== value) {
      context.addIssue({ code: "custom", message: "Repository URL must be canonical" });
    }
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Repository URL is invalid" });
  }
});
const fullLowercaseCommitSchema = z.string().regex(
  /^[0-9a-f]{40}$/,
  "Commit must be a full lowercase 40 character hexadecimal SHA-1 object ID",
);

export const bindingWorkspaceSchema: z.ZodType<BindingWorkspace> = z
  .discriminatedUnion("type", [
    emptyWorkspaceSchema,
    z
      .object({
        type: z.literal("git"),
        repository: z.object({ url: selectorSchema }).strict(),
        revision: z.object({ commit: selectorSchema }).strict(),
      })
      .strict(),
  ])
  .openapi("BindingWorkspaceSelector");

export const resolvedWorkspaceSchema: z.ZodType<ResolvedWorkspace> = z
  .discriminatedUnion("type", [
    emptyWorkspaceSchema,
    z
      .object({
        type: z.literal("git"),
        repository: z.object({ url: canonicalRepositoryUrlSchema }).strict(),
        revision: z.object({ type: z.literal("commit"), commit: fullLowercaseCommitSchema }).strict(),
      })
      .strict(),
  ])
  .openapi("ResolvedWorkspace");
