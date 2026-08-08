import { describe, expect, it } from "vitest";
import { readPostgresRuntimeStoreOptions } from "../../src/runtime/store.js";

describe("readPostgresRuntimeStoreOptions", () => {
  it.each(["5432.5", "-1", "65536"]) ("rejects invalid database port %s", (value) => {
    expect(() => readPostgresRuntimeStoreOptions({
      DISPATCH_DATABASE_HOST: "127.0.0.1",
      DISPATCH_DATABASE_PORT: value,
    })).toThrow(/DISPATCH_DATABASE_PORT|port|integer/i);
  });

  it("accepts a valid database port", () => {
    expect(readPostgresRuntimeStoreOptions({
      DISPATCH_DATABASE_HOST: "127.0.0.1",
      DISPATCH_DATABASE_PORT: "5432",
    }).port).toBe(5432);
  });

  it("defaults the database port", () => {
    expect(readPostgresRuntimeStoreOptions({ DISPATCH_DATABASE_HOST: "127.0.0.1" }).port).toBe(5432);
  });
});
