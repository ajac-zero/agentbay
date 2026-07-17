import { createHash } from "node:crypto";

export type IdempotencyPart = boolean | number | string;

function frame(part: IdempotencyPart): string {
  if (typeof part === "number" && !Number.isFinite(part)) {
    throw new Error("idempotency key number parts must be finite");
  }

  const type = typeof part;
  const value = String(part);
  return `${type}:${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function createIdempotencyKey(namespace: string, ...parts: readonly IdempotencyPart[]): string {
  if (!/^[a-z][a-z0-9-]*$/.test(namespace)) {
    throw new Error("idempotency key namespace must be lowercase alphanumeric with optional hyphens");
  }
  if (parts.length === 0) throw new Error("idempotency key requires at least one part");

  const input = parts.map(frame).join("");
  return `${namespace}:${createHash("sha256").update(input).digest("hex")}`;
}

export function sourceDeliveryIdempotencyKey(connectorId: string, deliveryId: string): string {
  return createIdempotencyKey("source-delivery", connectorId, deliveryId);
}

export function eventIdempotencyKey(source: string, eventId: string): string {
  return createIdempotencyKey("event", source, eventId);
}

export function executionIdempotencyKey(bindingId: string, source: string, eventId: string): string {
  return createIdempotencyKey("execution", bindingId, source, eventId);
}

export function transitionIdempotencyKey(executionId: string, transitionId: string): string {
  return createIdempotencyKey("transition", executionId, transitionId);
}

export function deliveryIdempotencyKey(executionId: string, destinationId: string): string {
  return createIdempotencyKey("delivery", executionId, destinationId);
}
