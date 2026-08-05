import { describe, expect, it } from "vitest";
import { readPostgresRuntimeStoreOptions } from "../../src/runtime/store.js";

describe("readPostgresRuntimeStoreOptions", () => {
  it("accepts a valid PostgreSQL TCP port", () => {
    expect(readPostgresRuntimeStoreOptions({
      AGENTBAY_DATABASE_HOST: "localhost",
      AGENTBAY_DATABASE_PORT: "5432",
    }).port).toBe(5432);
  });

  it.each(["5432.5", "-1", "65536"])("rejects invalid PostgreSQL TCP port %s", (port) => {
    expect(() => readPostgresRuntimeStoreOptions({
      AGENTBAY_DATABASE_HOST: "localhost",
      AGENTBAY_DATABASE_PORT: port,
    })).toThrow(/AGENTBAY_DATABASE_PORT/);
  });
});
