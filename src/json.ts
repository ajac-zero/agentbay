import { createHash } from "node:crypto";
import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export function canonicalJson(value: JsonValue): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON numbers must be finite");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

export function hashCanonicalJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function isJsonPointer(value: string): boolean {
  return value === "" || (value.startsWith("/") && !/~(?:[^01]|$)/.test(value));
}

export const jsonPointerSchema = z.string().refine(isJsonPointer, "must be an RFC 6901 JSON pointer");

export type JsonPointerResolution =
  | { found: true; value: JsonValue }
  | { found: false };

export function resolveJsonPointer(document: JsonValue, pointer: string): JsonPointerResolution {
  if (!isJsonPointer(pointer)) throw new Error(`Invalid RFC 6901 JSON pointer: ${pointer}`);
  if (pointer === "") return { found: true, value: document };

  let current: JsonValue = document;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = encodedToken.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return { found: false };
      current = current[index]!;
      continue;
    }
    if (current !== null && typeof current === "object" && Object.hasOwn(current, token)) {
      current = current[token]!;
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}
