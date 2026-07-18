import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonicalJson, isJsonPointer, resolveJsonPointer } from "../../src/json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively without changing array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: [3, 1] } })).toBe('{"a":{"x":[3,1],"y":2},"z":1}');
  });

  it("hashes equivalent objects identically", () => {
    expect(hashCanonicalJson({ b: 2, a: 1 })).toBe(hashCanonicalJson({ a: 1, b: 2 }));
    expect(hashCanonicalJson({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
    expect(() => hashCanonicalJson(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("RFC 6901 JSON pointers", () => {
  const document = { "a/b": { "m~n": [false, null] }, empty: { "": "value" } };

  it("validates pointers and escape sequences", () => {
    expect(isJsonPointer("")).toBe(true);
    expect(isJsonPointer("/a~1b/m~0n/0")).toBe(true);
    expect(isJsonPointer("missing-leading-slash")).toBe(false);
    expect(isJsonPointer("/bad~2escape")).toBe(false);
    expect(isJsonPointer("/trailing~")).toBe(false);
  });

  it("resolves roots, escaped object keys, empty keys, and array indexes", () => {
    expect(resolveJsonPointer(document, "")).toEqual({ found: true, value: document });
    expect(resolveJsonPointer(document, "/a~1b/m~0n/0")).toEqual({ found: true, value: false });
    expect(resolveJsonPointer(document, "/empty/")).toEqual({ found: true, value: "value" });
    expect(resolveJsonPointer(document, "/a~1b/m~0n/2")).toEqual({ found: false });
    expect(resolveJsonPointer(document, "/a~1b/m~0n/01")).toEqual({ found: false });
  });

  it("throws for an invalid pointer rather than treating it as missing", () => {
    expect(() => resolveJsonPointer(document, "/bad~escape")).toThrow(/Invalid RFC 6901/);
  });
});
