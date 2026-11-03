import { expect, test } from "bun:test";
import { parseSprintResult, quotaResetAt, requireSprintReview } from "./sprint-result.ts";
test("review requires an explicit PASS on the verified revision with no findings", () => {
  const result = parseSprintResult(['<sprint-result>{"verdict":"PASS","candidate":"sha","findings":[]}</sprint-result>']);
  expect(() => requireSprintReview(result, "sha")).not.toThrow();
  for (const invalid of [{}, { ...result, verdict: "REQUEST_CHANGES" }, { ...result, candidate: "old" }, { ...result, findings: ["bug"] }]) expect(() => requireSprintReview(invalid, "sha")).toThrow();
  expect(() => parseSprintResult(["Agent exited successfully"])).toThrow();
  expect(() => parseSprintResult(['<sprint-result>{}</sprint-result><sprint-result>{}</sprint-result>'])).toThrow();
  expect(() => parseSprintResult(['```json\n<sprint-result>{"verdict":"PASS","candidate":"sha","findings":[]}</sprint-result>\n```'])).toThrow();
  expect(() => parseSprintResult(['`<sprint-result>{"verdict":"PASS","candidate":"sha","findings":[]}</sprint-result>`'])).toThrow();
});
test("quota waits honor reset and Retry-After; unknown resets back off", () => {
  const now = Date.parse("2026-11-03T00:00:00Z");
  expect(quotaResetAt("Quota exhausted, reset at 2026-11-03T02:00:00Z", now, 0)).toBe(now + 7200_000);
  expect(quotaResetAt("rate limit; retry-after: 60", now, 0)).toBe(now + 60_000);
  expect(quotaResetAt(`{"error":"quota","resetsAt":${(now + 7200_000) / 1000}}`, now, 0)).toBe(now + 7200_000);
  expect(quotaResetAt('rate limit {"retry_after":3600}', now, 0)).toBe(now + 3600_000);
  expect(quotaResetAt("quota resets in 2 hours", now, 0)).toBe(now + 7200_000);
  expect(quotaResetAt("quota exhausted", now, 2)).toBeGreaterThan(quotaResetAt("quota exhausted", now, 0)!);
  expect(quotaResetAt("test failed", now, 0)).toBeNull();
});
