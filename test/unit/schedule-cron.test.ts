import { describe, expect, it } from "vitest";
import { cronExpressionSchema, nextCronOccurrence } from "../../src/schedule/cron.js";

describe("schedule cron", () => {
  it("calculates UTC occurrences for standard five-field expressions", () => {
    expect(nextCronOccurrence("17 * * * *", new Date("2026-07-20T17:17:00Z")).toISOString()).toBe("2026-07-20T18:17:00.000Z");
    expect(nextCronOccurrence("*/15 9-10 * * 1-5", new Date("2026-07-17T10:59:00Z")).toISOString()).toBe("2026-07-20T09:00:00.000Z");
    expect(nextCronOccurrence("0 0 1 1 *", new Date("2026-01-01T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(nextCronOccurrence("0 0 1 * 1", new Date("2026-07-20T00:00:00Z")).toISOString()).toBe("2026-07-27T00:00:00.000Z");
  });

  it.each(["* * *", "60 * * * *", "*/0 * * * *", "* 24 * * *", "* * 0 * *", "* * * * 7", "a * * * *"])(
    "rejects invalid expression %s", (expression) => expect(cronExpressionSchema.safeParse(expression).success).toBe(false),
  );
});
