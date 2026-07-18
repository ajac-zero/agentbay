import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// The production artifact intentionally remains standalone JavaScript for direct use in the image.
// @ts-expect-error no declaration file is shipped for the standalone image script
import { materializeWorkspace, validateCommit, validatePublicHttpsGitUrl } from "../../sandbox-image/git-workspace-materializer.mjs";

const commit = "A".repeat(40);
const directories: string[] = [];
const publicResolver = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentbay-workspace-test-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }));
});

describe("git workspace input validation", () => {
  it("accepts only full SHA-1 object IDs and normalizes case", () => {
    expect(validateCommit(commit)).toBe("a".repeat(40));
    expect(() => validateCommit("b".repeat(64))).toThrow(/40 character/);
    expect(() => validateCommit("a".repeat(39))).toThrow(/40 character/);
    expect(() => validateCommit(`${"a".repeat(39)};`)).toThrow(/40 character/);
  });

  it("requires credential-free public HTTPS URLs", () => {
    expect(validatePublicHttpsGitUrl("https://github.com/example/repo.git")).toBe("https://github.com/example/repo.git");
    for (const url of [
      "http://github.com/example/repo.git",
      "https://user:secret@github.com/example/repo.git",
      "https://localhost/repo.git",
      "https://service/repo.git",
      "https://service.local/repo.git",
      "https://service.internal/repo.git",
      "https://127.0.0.1/repo.git",
      "https://10.0.0.1/repo.git",
      "https://192.0.2.1/repo.git",
      "https://[::1]/repo.git",
      "file:///tmp/repo",
    ]) expect(() => validatePublicHttpsGitUrl(url)).toThrow();
  });
});

describe("materializeWorkspace", () => {
  it("does nothing for an empty workspace", async () => {
    const runner = vi.fn();
    const resolver = vi.fn();
    await materializeWorkspace({ environment: { AGENTBAY_WORKSPACE_TYPE: "empty" }, runner, resolver });
    expect(runner).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("uses fixed shell-free Git commands in order and verifies the exact commit", async () => {
    const directory = await temporaryDirectory();
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    runner.mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${commit.toLowerCase()}\n`, stderr: "" });

    await materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/repo;touch-pwned",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: publicResolver,
    });

    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls.map((call) => [call[0], call[1].slice(-1)[0]])).toEqual([
      ["/usr/bin/git", directory],
      ["/usr/bin/git", commit.toLowerCase()],
      ["/usr/bin/git", "FETCH_HEAD"],
      ["/usr/bin/git", "HEAD^{commit}"],
    ]);
    const fetchArgs = runner.mock.calls[1]![1] as string[];
    expect(fetchArgs).toContain("https://github.com/repo;touch-pwned");
    expect(fetchArgs).toEqual(expect.arrayContaining(["fetch", "--no-tags", "--depth=1", "--no-recurse-submodules"]));
    expect(fetchArgs).toEqual(expect.arrayContaining(["-c", "http.curloptResolve=github.com:443:93.184.216.34"]));
    expect(publicResolver).toHaveBeenCalledWith("github.com", { all: true, verbatim: true });
    expect(runner.mock.calls.every((call) => call[2].shell === false)).toBe(true);
    expect(runner.mock.calls[0]![2].env).toMatchObject({
      HOME: "/nonexistent",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(runner.mock.calls[0]![2].env).not.toHaveProperty("HTTPS_PROXY");
  });

  it("rejects a non-empty target before running Git", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "keep.txt"), "do not replace");
    const runner = vi.fn();
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: publicResolver,
    })).rejects.toThrow(/must be empty/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a symlink target even when its destination is empty", async () => {
    const parent = await temporaryDirectory();
    const destination = await temporaryDirectory();
    const directory = join(parent, "workspace");
    await symlink(destination, directory);
    const runner = vi.fn();
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: publicResolver,
    })).rejects.toThrow(/must be a directory/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects a mismatched checked-out commit", async () => {
    const directory = await temporaryDirectory();
    const runner = vi.fn().mockResolvedValue({ stdout: `${"b".repeat(40)}\n`, stderr: "" });
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: publicResolver,
    })).rejects.toThrow(/unexpected commit/);
  });

  it("bounds and strips control characters from Git failures", async () => {
    const directory = await temporaryDirectory();
    const runner = vi.fn().mockRejectedValue({ stderr: `bad\n\u001b[31m${"x".repeat(2000)}` });
    const result = materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: publicResolver,
    });
    await expect(result).rejects.toThrow(/^Git workspace initialization failed: bad \[31m/);
    await expect(result).rejects.toSatisfy((error: Error) => error.message.length < 600);
  });

  it.each([
    [[{ address: "10.0.0.1", family: 4 }]],
    [[{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }]],
  ])("rejects private or mixed DNS answers before running Git", async (answers) => {
    const directory = await temporaryDirectory();
    const runner = vi.fn();
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: vi.fn().mockResolvedValue(answers),
    })).rejects.toThrow(/non-public address/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects IPv6 destinations", async () => {
    const directory = await temporaryDirectory();
    const runner = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    runner.mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: `${commit.toLowerCase()}\n`, stderr: "" });
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_DIRECTORY: directory,
        AGENTBAY_WORKSPACE_GIT_URL: "https://github.com/example/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      runner,
      resolver: vi.fn().mockResolvedValue([{ address: "2606:4700:4700::1111", family: 6 }]),
    })).rejects.toThrow(/non-public address/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not resolve an invalid URL", async () => {
    const resolver = vi.fn();
    await expect(materializeWorkspace({
      environment: {
        AGENTBAY_WORKSPACE_TYPE: "git",
        AGENTBAY_WORKSPACE_GIT_URL: "https://localhost/repo.git",
        AGENTBAY_WORKSPACE_GIT_COMMIT: commit,
      },
      resolver,
    })).rejects.toThrow(/host must be public/);
    expect(resolver).not.toHaveBeenCalled();
  });
});
