export type CloudEventAttributeValue = boolean | number | string;

export type CloudEvent<TData = unknown> = {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  time?: string;
  datacontenttype?: string;
  dataschema?: string;
  data?: TData;
  data_base64?: string;
  [attribute: string]: unknown;
};

export type CloudEventValidationIssue = {
  attribute: string;
  message: string;
};

export type CloudEventValidationResult<TData = unknown> =
  | { valid: true; event: CloudEvent<TData> }
  | { valid: false; issues: CloudEventValidationIssue[] };

const coreAttributes = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "subject",
  "time",
  "datacontenttype",
  "dataschema",
  "data",
  "data_base64",
]);
const extensionNamePattern = /^[a-z0-9]{1,20}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUriReference(value: string): boolean {
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    new URL(value, "https://agentbay.invalid");
    return true;
  } catch {
    return false;
  }
}

function isAbsoluteUri(value: string): boolean {
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    return new URL(value).protocol.length > 1;
  } catch {
    return false;
  }
}

export function validateCloudEvent<TData = unknown>(value: unknown): CloudEventValidationResult<TData> {
  if (!isRecord(value)) {
    return { valid: false, issues: [{ attribute: "$", message: "must be an object" }] };
  }

  const issues: CloudEventValidationIssue[] = [];
  const requireString = (attribute: "id" | "source" | "type") => {
    if (typeof value[attribute] !== "string" || value[attribute].length === 0) {
      issues.push({ attribute, message: "must be a non-empty string" });
    }
  };

  if (value.specversion !== "1.0") {
    issues.push({ attribute: "specversion", message: 'must equal "1.0"' });
  }
  requireString("id");
  requireString("source");
  requireString("type");

  if (typeof value.source === "string" && value.source.length > 0 && !isUriReference(value.source)) {
    issues.push({ attribute: "source", message: "must be a URI-reference" });
  }
  if (value.subject !== undefined && typeof value.subject !== "string") {
    issues.push({ attribute: "subject", message: "must be a string" });
  }
  if (value.time !== undefined) {
    if (
      typeof value.time !== "string" ||
      !timestampPattern.test(value.time) ||
      !Number.isFinite(Date.parse(value.time))
    ) {
      issues.push({ attribute: "time", message: "must be an RFC 3339 timestamp" });
    }
  }
  if (value.datacontenttype !== undefined && (typeof value.datacontenttype !== "string" || value.datacontenttype.length === 0)) {
    issues.push({ attribute: "datacontenttype", message: "must be a non-empty string" });
  }
  if (value.dataschema !== undefined && (typeof value.dataschema !== "string" || !isAbsoluteUri(value.dataschema))) {
    issues.push({ attribute: "dataschema", message: "must be an absolute URI" });
  }
  if (value.data !== undefined && value.data_base64 !== undefined) {
    issues.push({ attribute: "data", message: "cannot be used with data_base64" });
  }
  if (value.data_base64 !== undefined && (typeof value.data_base64 !== "string" || !base64Pattern.test(value.data_base64))) {
    issues.push({ attribute: "data_base64", message: "must be a base64 string" });
  }

  for (const [attribute, attributeValue] of Object.entries(value)) {
    if (coreAttributes.has(attribute)) continue;
    if (!extensionNamePattern.test(attribute)) {
      issues.push({ attribute, message: "extension names must be 1-20 lowercase alphanumeric characters" });
      continue;
    }
    if (
      typeof attributeValue !== "string" &&
      typeof attributeValue !== "boolean" &&
      !(typeof attributeValue === "number" && Number.isSafeInteger(attributeValue))
    ) {
      issues.push({ attribute, message: "extension values must be strings, booleans, or safe integers" });
    }
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, event: value as CloudEvent<TData> };
}

export function isCloudEvent(value: unknown): value is CloudEvent {
  return validateCloudEvent(value).valid;
}
