import { describe, expect, it } from "vitest";
import { resolveWorkspace, WorkspaceResolutionError } from "../../src/workspace/resolver.js";
import type { BindingWorkspace } from "../../src/workspace/types.js";

const workspace: BindingWorkspace = {
  type: "git",
  repository: { url: { path: "/repository/url" } },
  revision: { commit: { path: "/revision/commit" } },
};

describe("resolveWorkspace", () => {
  it("passes through empty workspaces", () => {
    expect(resolveWorkspace({ type: "empty" }, null)).toEqual({ type: "empty" });
  });

  it("reports invalid selectors as workspace resolution errors", () => {
    const invalid = {
      ...workspace,
      repository: { url: { path: "/bad~2pointer" } },
    };
    expect(() => resolveWorkspace(invalid, {})).toThrowError(WorkspaceResolutionError);
  });

  it("resolves RFC 6901 selectors and canonicalizes Git inputs", () => {
    expect(resolveWorkspace(workspace, {
      repository: { url: "https://Git.Example.test/acme/repo name" },
      revision: { commit: "ABCDEF0123456789ABCDEF0123456789ABCDEF01" },
    })).toEqual({
      type: "git",
      repository: { url: "https://git.example.test/acme/repo%20name" },
      revision: { type: "commit", commit: "abcdef0123456789abcdef0123456789abcdef01" },
    });
  });

  it.each([
    [{ repository: {}, revision: { commit: "a".repeat(40) } }, "repository URL is missing"],
    [{ repository: { url: 42 }, revision: { commit: "a".repeat(40) } }, "repository URL at event.data pointer"],
    [{ repository: { url: "https://git.example.test/repo" }, revision: {} }, "revision commit is missing"],
    [{ repository: { url: "https://git.example.test/repo" }, revision: { commit: false } }, "revision commit at event.data pointer"],
  ])("rejects a missing or non-string selected value", (data, message) => {
    expect(() => resolveWorkspace(workspace, data)).toThrowError(new RegExp(message));
  });

  it.each([
    "http://git.example.test/repo",
    "https://user:secret@git.example.test/repo",
    "https://git.example.test/repo#branch",
    "https://localhost/repo",
    "https://service/repo",
    "https://service.local/repo",
    "https://service.internal/repo",
    "https://127.0.0.1/repo",
    "https://192.0.2.1/repo",
    "https://[::ffff:127.0.0.1]/repo",
    `https://git.example.test/${"x".repeat(2048)}`,
    "https://git.example.test/repo\n",
    "https://git.example.test/repo%00name",
  ])("rejects an unsafe repository URL: %s", (url) => {
    expect(() => resolveWorkspace(workspace, {
      repository: { url },
      revision: { commit: "a".repeat(40) },
    })).toThrow(WorkspaceResolutionError);
  });

  it.each(["main", "abc123", "g".repeat(40), "a".repeat(39), "a".repeat(41), "a".repeat(64)])(
    "rejects a non-full commit: %s",
    (commit) => {
      expect(() => resolveWorkspace(workspace, {
        repository: { url: "https://git.example.test/repo" },
        revision: { commit },
      })).toThrowError(/full 40 character hexadecimal SHA-1 object ID/);
    },
  );

});
