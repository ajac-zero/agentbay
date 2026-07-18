import type { Execution, ExecutionInput } from "../execution/types.js";
import type { NormalizedCloudEvent } from "../execution/events.js";
import { bindingExecutionIdempotencyKey } from "../execution/idempotency.js";
import { canonicalJson, resolveJsonPointer, type JsonPrimitive, type JsonValue } from "../json.js";
import type { BindingDefinition, FilterClause, PublishedBindingVersion } from "./binding.js";

export const UNTRUSTED_EVENT_BEGIN = "--- BEGIN UNTRUSTED EVENT ---";
export const UNTRUSTED_EVENT_END = "--- END UNTRUSTED EVENT ---";

function primitiveEquals(left: JsonValue, right: JsonPrimitive): boolean {
  return left === right;
}

export function matchesFilterClause(data: JsonValue, clause: FilterClause): boolean {
  const resolution = resolveJsonPointer(data, clause.path);
  if (clause.op === "exists") return resolution.found === clause.value;
  if (!resolution.found || (resolution.value !== null && typeof resolution.value === "object")) return false;
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
  const prompt = binding.definition.prompt;
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
  replayed: boolean;
};

export function planExecution(binding: PublishedBindingVersion, command: AdmissionCommand): Execution | undefined {
  if (binding.tenantId !== command.tenantId || binding.triggerId !== command.triggerId || !matchesBinding(binding, command.event)) return undefined;
  const id = bindingExecutionIdempotencyKey(binding.id, command.internalEventId);
  return {
    id,
    binding: { id: binding.bindingId, version: binding.version },
    tenantId: command.tenantId,
    state: "QUEUED",
    profile: binding.profile,
    input: renderBindingInput(binding, command.event),
    workspace: binding.definition.workspace,
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
    replayed,
  };
}

export type { BindingDefinition };
