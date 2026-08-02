import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/sandbox/client.js", () => ({
  createKubeConfig: vi.fn(),
  createCustomObjectsApi: vi.fn().mockReturnValue({
    listNamespacedCustomObject: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
  }),
}));

import { reconcileOnce } from "../../src/reconcile.js";

describe("reconcileOnce grace validation", () => {
  it.each([-30, 2.5, Infinity])(
    "rejects invalid graceMinutes %s before listing or deleting claims",
    async (graceMinutes) => {
      const list = vi.fn().mockResolvedValue({ items: [] });
      const remove = vi.fn().mockResolvedValue({});
      const api = { listNamespacedCustomObject: list, deleteNamespacedCustomObject: remove };

      await expect(
        reconcileOnce(api, {
          namespace: "agents",
          apiVersion: "v1beta1",
          graceMinutes,
          now: Date.parse("2026-08-02T12:00:00.000Z"),
        }),
      ).rejects.toThrow(/graceMinutes must be a nonnegative safe integer/);

      expect(list).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    },
  );
});
