import type { Execution, ExecutionInput } from "../execution/types.js";
import type { NormalizedCloudEvent } from "../execution/events.js";
import { bindingExecutionIdempotencyKey } from "../execution/idempotency.js";
import { canonicalJson, resolveJsonPointer, type JsonPrimitive, type JsonValue } from "../json.js";
import type { BindingDefinition, FilterClause, PublishedBindingVersion, WakeBindingDefinition } from "./binding.js";
import { resolveWorkspace } from "../workspace/resolver.js";

export const UNTRUSTED_EVENT_BEGIN = "--- BEGIN UNTRUSTED EVENT ---";
export const UNTRUSTED_EVENT_END = "--- END UNTRUSTED EVENT ---";

function primitiveEquals(left: JsonValue, right: JsonPrimitive): boolean {
  return left === right;
}

export function matchesFilterClause(data: JsonValue, clause: FilterClause): boolean {
  const resolution = resolveJsonPointer(data, clause.path);
  if (clause.op === "exists") return resolution.found === clause.value;
  if (!resolution.found) return false;
  if (clause.op === "contains" || clause.op === "containsAny") {
    if (!Array.isArray(resolution.value)) return false;
    const primitives = resolution.value.filter((value): value is JsonPrimitive => value === null || typeof value !== "object");
    if (primitives.length !== resolution.value.length) return false;
    return clause.op === "contains"
      ? primitives.some((value) => primitiveEquals(value, clause.value))
      : clause.values.some((expected) => primitives.some((value) => primitiveEquals(value, expected)));
  }
  if (resolution.value !== null && typeof resolution.value === "object") return false;
  if (clause.op === "eq") return primitiveEquals(resolution.value, clause.value);
  return clause.values.some((value) => primitiveEquals(resolution.value, value));
}

export function matchesBinding(binding: PublishedBindingVersion, event: NormalizedCloudEvent): boolean {
  return (
    binding.enabled &&
    binding.definition.eventTypes.includes(event.type) &&
    binding.definition.filter.all.every((clause) => matchesFilterClause(event.data, clause))
  );
}

export function renderBindingInput(binding: PublishedBindingVersion, event: NormalizedCloudEvent): ExecutionInput {
  if ("disposition" in binding.definition) throw new Error("Wake bindings do not create execution input");
  return renderPromptInput(binding.definition.prompt, event);
}

export function renderPromptInput(prompt: { literal: string; includeEvent: "none" | "data" | "envelope" }, event: NormalizedCloudEvent): ExecutionInput {
  const included = prompt.includeEvent === "data" ? event.data : prompt.includeEvent === "envelope" ? event : undefined;
  if (included === undefined) return { text: prompt.literal };
  const serialized = canonicalJson(included as JsonValue);
  return {
    text: `${prompt.literal}\n\n${UNTRUSTED_EVENT_BEGIN}\n${serialized}\n${UNTRUSTED_EVENT_END}`,
    context: { event: included as JsonValue, includeEvent: prompt.includeEvent },
  };
}

export type AdmissionCommand = {
  tenantId: string;
  triggerId: string;
  internalEventId: string;
  event: NormalizedCloudEvent;
  sourceDeduplicationKey: string;
  admissionHash: string;
  admittedAt: string;
};

export type AdmittedEventSummary = {
  id: string;
  tenantId: string;
  triggerId: string;
  source: string;
  eventId: string;
  type: string;
  sourceDeduplicationKey: string;
  admissionHash: string;
  admittedAt: string;
};

export type AdmissionResult = {
  event: AdmittedEventSummary;
  executions: Execution[];
  wakes: AdmissionWakeResult[];
  replayed: boolean;
};

export type AdmissionWakeResult = {
  id: string;
  executionId: string;
  eventWaitId: string;
  binding: { id: string; version: number };
  action: "CONTINUED" | "COMPLETED";
  inputSequence: number | null;
  state: "QUEUED" | "COMPLETED";
  consumedAt: string;
};

export function projectWakeCorrelation(definition: WakeBindingDefinition, event: NormalizedCloudEvent): Record<string, JsonPrimitive> | undefined {
  const correlation: Record<string, JsonPrimitive> = {};
  for (const item of definition.wake.correlation) {
    const resolved = resolveJsonPointer(event.data, item.path);
    if (!resolved.found || (resolved.value !== null && typeof resolved.value === "object")
      || Buffer.byteLength(JSON.stringify(resolved.value), "utf8") > 1_024) return undefined;
    correlation[item.name] = resolved.value;
  }
  return correlation;
}

export function planExecution(binding: PublishedBindingVersion, command: AdmissionCommand): Execution | undefined {
  if ("disposition" in binding.definition || binding.tenantId !== command.tenantId || binding.triggerId !== command.triggerId || !matchesBinding(binding, command.event)) return undefined;
  const id = bindingExecutionIdempotencyKey(binding.id, command.internalEventId);
  return {
    id,
    binding: { id: binding.bindingId, version: binding.version },
    tenantId: command.tenantId,
    state: "QUEUED",
    profile: binding.profile,
    input: renderBindingInput(binding, command.event),
    workspace: resolveWorkspace(binding.definition.workspace, command.event.data),
    eventId: command.internalEventId,
    createdAt: command.admittedAt,
    updatedAt: command.admittedAt,
    result: null,
  };
}

export function planAdmission(
  command: AdmissionCommand,
  bindings: readonly PublishedBindingVersion[],
  replayed = false,
): AdmissionResult {
  const executions = bindings.map((binding) => planExecution(binding, command)).filter((execution): execution is Execution => execution !== undefined);
  return {
    event: {
      id: command.internalEventId,
      tenantId: command.tenantId,
      triggerId: command.triggerId,
      source: command.event.source,
      eventId: command.event.id,
      type: command.event.type,
      sourceDeduplicationKey: command.sourceDeduplicationKey,
      admissionHash: command.admissionHash,
      admittedAt: command.admittedAt,
    },
    executions,
    wakes: [],
    replayed,
  };
}

export type { BindingDefinition };
