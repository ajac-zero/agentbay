/**
 * Unit tests for reconcile.ts — readApiVersion, isNotFound, reconcileOnce.
 *
 * vi.mock is hoisted before the import so that when reconcile.ts is first
 * imported its module-level reconcile() call hits the mock API (returns an
 * empty item list) and exits cleanly without making real network requests or
 * calling process.exit.
 */

import { describe, expect, it, vi } from "vitest";

// Provide a harmless stub so the module-level reconcile() call does not make
// real Kubernetes API calls or call process.exit when this file is imported.
vi.mock("../../src/sandbox/client.js", () => ({
  createKubeConfig: vi.fn(),
  createCustomObjectsApi: vi.fn().mockReturnValue({
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  }),
}));

import { isNotFound, readApiVersion, reconcileOnce } from "../../src/reconcile.js";
import type { SandboxClaim } from "../../src/sandbox/types.js";

// ---------------------------------------------------------------------------
// readApiVersion
// ---------------------------------------------------------------------------

describe("readApiVersion", () => {
  it("defaults to v1alpha1 when undefined", () => {
    expect(readApiVersion(undefined)).toBe("v1alpha1");
  });

  it("defaults to v1alpha1 when empty string", () => {
    expect(readApiVersion("")).toBe("v1alpha1");
  });

  it("accepts v1alpha1", () => {
    expect(readApiVersion("v1alpha1")).toBe("v1alpha1");
  });

  it("accepts v1beta1", () => {
    expect(readApiVersion("v1beta1")).toBe("v1beta1");
  });

  it("throws on unsupported version string", () => {
    expect(() => readApiVersion("v2")).toThrow(/Expected AGENTBAY_SANDBOX_CLAIM_API_VERSION/);
    expect(() => readApiVersion("latest")).toThrow(/Expected AGENTBAY_SANDBOX_CLAIM_API_VERSION/);
  });
});

// ---------------------------------------------------------------------------
// isNotFound
// ---------------------------------------------------------------------------

describe("isNotFound", () => {
  it("returns false for null", () => {
    expect(isNotFound(null)).toBe(false);
  });

  it("returns false for a primitive", () => {
    expect(isNotFound("404")).toBe(false);
    expect(isNotFound(404)).toBe(false);
  });

  it("returns true for { code: 404 }", () => {
    expect(isNotFound({ code: 404 })).toBe(true);
  });

  it("returns true for { response: { statusCode: 404 } }", () => {
    expect(isNotFound({ response: { statusCode: 404 } })).toBe(true);
  });

  it("returns true for { response: { status: 404 } }", () => {
    expect(isNotFound({ response: { status: 404 } })).toBe(true);
  });

  it("returns false for a non-404 code", () => {
    expect(isNotFound({ code: 500 })).toBe(false);
    expect(isNotFound({ response: { statusCode: 403 } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconcileOnce — helpers
// ---------------------------------------------------------------------------

const NAMESPACE = "test-ns";
const API_VERSION = "v1alpha1" as const;
const BASE_OPTS = { namespace: NAMESPACE, apiVersion: API_VERSION, graceMinutes: 30, now: Date.now() };

function claim(name: string, shutdownTime?: string): SandboxClaim {
  return {
    apiVersion: "extensions.agents.x-k8s.io/v1alpha1",
    kind: "SandboxClaim",
    metadata: { name, namespace: NAMESPACE },
    spec: {
      sandboxTemplateRef: { name: "tmpl" },
      ...(shutdownTime ? { lifecycle: { shutdownTime } } : {}),
    },
  };
}

/** shutdownTime that is `ms` milliseconds in the past relative to BASE_OPTS.now. */
function msAgo(ms: number): string {
  return new Date(BASE_OPTS.now - ms).toISOString();
}

/** shutdownTime that is `ms` milliseconds in the future relative to BASE_OPTS.now. */
function msFromNow(ms: number): string {
  return new Date(BASE_OPTS.now + ms).toISOString();
}

function fakeApi(items: SandboxClaim[], deleteError?: unknown) {
  const list = vi.fn().mockResolvedValue({ items });
  const del = deleteError ? vi.fn().mockRejectedValue(deleteError) : vi.fn().mockResolvedValue({});
  return { listNamespacedCustomObject: list, deleteNamespacedCustomObject: del };
}

// ---------------------------------------------------------------------------
// reconcileOnce tests
// ---------------------------------------------------------------------------

describe("reconcileOnce", () => {
  it("returns zeros when there are no claims", async () => {
    const api = fakeApi([]);
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 0, total: 0 });
    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("treats a missing items array as an empty list", async () => {
    const list = vi.fn().mockResolvedValue({});
    const del = vi.fn();
    await expect(
      reconcileOnce({ listNamespacedCustomObject: list, deleteNamespacedCustomObject: del }, BASE_OPTS),
    ).resolves.toEqual({ deleted: 0, errors: 0, total: 0 });
  });

  it("skips claims with no shutdownTime", async () => {
    const api = fakeApi([claim("no-shutdown")]);
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 0, total: 1 });
    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("skips claims whose shutdownTime is within the grace period", async () => {
    // Shutdown 1 minute ago; grace = 30 minutes → deadline is 29 minutes from now
    const api = fakeApi([claim("active", msAgo(60_000))]);
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 0, total: 1 });
    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("skips claims whose shutdownTime is in the future", async () => {
    const api = fakeApi([claim("future", msFromNow(60_000))]);
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 0, total: 1 });
    expect(api.deleteNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it("deletes a claim that is past its grace period", async () => {
    const shutdownTime = msAgo(31 * 60_000); // 31 minutes ago; grace = 30 → past deadline
    const api = fakeApi([claim("expired", shutdownTime)]);

    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 1, errors: 0, total: 1 });

    expect(api.deleteNamespacedCustomObject).toHaveBeenCalledOnce();
    expect(api.deleteNamespacedCustomObject).toHaveBeenCalledWith({
      group: "extensions.agents.x-k8s.io",
      version: API_VERSION,
      namespace: NAMESPACE,
      plural: "sandboxclaims",
      name: "expired",
      propagationPolicy: "Foreground",
    });
  });

  it("does not count a 404 delete response as an error (claim already gone)", async () => {
    const api = fakeApi([claim("gone", msAgo(31 * 60_000))], { code: 404 });
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 0, total: 1 });
  });

  it("counts non-404 delete failures in errors", async () => {
    const api = fakeApi([claim("bad", msAgo(31 * 60_000))], new Error("server error"));
    await expect(reconcileOnce(api, BASE_OPTS)).resolves.toEqual({ deleted: 0, errors: 1, total: 1 });
  });

  it("handles a mix of skipped, deleted, and error claims correctly", async () => {
    const active = claim("active", msAgo(1_000)); // within grace
    const expired1 = claim("expired-1", msAgo(31 * 60_000)); // past grace
    const noShutdown = claim("no-shutdown"); // no shutdownTime
    const expired2 = claim("expired-2", msAgo(60 * 60_000)); // past grace

    // expired-2 delete fails
    const list = vi.fn().mockResolvedValue({ items: [active, expired1, noShutdown, expired2] });
    const del = vi
      .fn()
      .mockResolvedValueOnce({}) // expired-1 succeeds
      .mockRejectedValueOnce(new Error("timeout")); // expired-2 fails

    await expect(
      reconcileOnce({ listNamespacedCustomObject: list, deleteNamespacedCustomObject: del }, BASE_OPTS),
    ).resolves.toEqual({ deleted: 1, errors: 1, total: 4 });
  });

  it("respects the graceMinutes option", async () => {
    const shutdownTime = msAgo(5 * 60_000); // 5 minutes ago

    // 3-minute grace → past deadline
    const api3 = fakeApi([claim("marginal", shutdownTime)]);
    await expect(reconcileOnce(api3, { ...BASE_OPTS, graceMinutes: 3 })).resolves.toMatchObject({
      deleted: 1,
    });

    // 10-minute grace → still within deadline
    const api10 = fakeApi([claim("marginal", shutdownTime)]);
    await expect(reconcileOnce(api10, { ...BASE_OPTS, graceMinutes: 10 })).resolves.toMatchObject({
      deleted: 0,
    });
  });

  it("passes the correct labelSelector and API version to listNamespacedCustomObject", async () => {
    const api = fakeApi([]);
    await reconcileOnce(api, { ...BASE_OPTS, apiVersion: "v1beta1", namespace: "custom-ns" });
    expect(api.listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "extensions.agents.x-k8s.io",
      version: "v1beta1",
      namespace: "custom-ns",
      plural: "sandboxclaims",
      labelSelector: "app.kubernetes.io/managed-by=agentbay",
    });
  });

  it("propagates errors from listNamespacedCustomObject", async () => {
    const list = vi.fn().mockRejectedValue(new Error("kube unreachable"));
    const del = vi.fn();
    await expect(
      reconcileOnce({ listNamespacedCustomObject: list, deleteNamespacedCustomObject: del }, BASE_OPTS),
    ).rejects.toThrow("kube unreachable");
  });
});
