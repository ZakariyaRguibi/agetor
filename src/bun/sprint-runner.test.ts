import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-runner-"));
const { createSprint, updateSprint, getSprint, sprintBatchHash, sprintSpecHash } = await import("./sprint-store.ts");
const { SprintRunner } = await import("./sprint-runner.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
import type { SprintHost } from "./sprint-runner.ts";

function fixture() {
  const sprint = createSprint(sprintFixture());
  return updateSprint(sprint.id, sprint.revision, (value) => { value.specApproval = sprintSpecHash(value.input); value.batchApproval = sprintBatchHash(value.input); value.status = "running"; });
}
function hostFixture() {
  const launches: string[] = [], merges: string[] = [], candidates = new Map<string, string>();
  const stopped: string[] = [];
  let reject = false, missing = false, quota = false, checksFail = false;
  const host: SprintHost = {
    async prepare() {}, capacity: () => 3,
    async launch(sprint, ticket, role, candidate) {
      const id = `${ticket.key}:${role}:${sprint.state[ticket.key]!.attempts}`;
      launches.push(id); if (candidate) candidates.set(id, candidate); return id;
    },
    async poll(id) {
      if (quota) return { status: "failed", output: "quota exhausted; retry-after: 3600" };
      return { status: "success", output: "", result: missing ? undefined : { verdict: reject ? "REQUEST_CHANGES" : "PASS", candidate: candidates.get(id), findings: reject ? ["bug"] : [] } };
    },
    async verify(_sprint, key) { if (checksFail) throw new Error("Tests failed"); return `sha-${key}`; },
    async integrate(_sprint, key) { merges.push(key); }, async finish() { return "pending"; },
    async cancel() {}, async stop(id) { stopped.push(id); }, notify() {},
  };
  return { host, launches, merges, stopped, setReject: () => { reject = true; }, setMissing: () => { missing = true; }, setQuota: () => { quota = true; }, setChecksFail: () => { checksFail = true; } };
}

test("pilot advances only after review; independent downstream tickets launch together", async () => {
  const sprint = fixture(), h = hostFixture(), runner = new SprintRunner(h.host);
  for (let i = 0; i < 35; i++) await runner.tick(sprint.id);
  expect(h.merges).toEqual(["LA-01", "LA-02", "LA-03", "LA-08"]);
  expect(h.launches.filter((id) => id.includes(":implement:"))).toEqual(["LA-01:implement:1", "LA-02:implement:1", "LA-03:implement:1", "LA-08:implement:1"]);
  expect(getSprint(sprint.id).status).toBe("verifying");
});

for (const failure of ["setReject", "setMissing", "setChecksFail"] as const) {
  test(`${failure} cannot complete a ticket and never resets the repair cap`, async () => {
    const sprint = fixture(), h = hostFixture(); h[failure]();
    for (let i = 0; i < 60; i++) await new SprintRunner(h.host).tick(sprint.id);
    const state = getSprint(sprint.id);
    expect(state.state["LA-01"]!.repairs).toBe(3);
    expect(state.state["LA-01"]!.status).toBe("failed");
    expect(state.status).toBe("needs_attention");
    expect(h.launches.some((id) => id.startsWith("LA-02:"))).toBe(false);
    expect(h.merges).toEqual([]);
  });
}

test("quota checkpoints wait without duplicate launches or resetting counters", async () => {
  const sprint = fixture(), h = hostFixture(); h.setQuota();
  for (let i = 0; i < 20; i++) await new SprintRunner(h.host).tick(sprint.id);
  const state = getSprint(sprint.id);
  expect(state.status).toBe("waiting_quota"); expect(state.state["LA-01"]!.retryAt).toBeGreaterThan(Date.now());
  expect(h.launches).toHaveLength(1); expect(state.state["LA-01"]!.attempts).toBe(1);
});

test("pause survives new runner instances and cannot ship", async () => {
  const sprint = fixture(), h = hostFixture(), runner = new SprintRunner(h.host);
  await runner.tick(sprint.id); await runner.tick(sprint.id);
  await runner.pause(sprint.id, getSprint(sprint.id).revision);
  for (let i = 0; i < 5; i++) await new SprintRunner(h.host).tick(sprint.id);
  expect(getSprint(sprint.id).status).toBe("paused"); expect(h.launches).toHaveLength(1); expect(h.merges).toEqual([]);
});

test("changed approved inputs stop before any agent launch", async () => {
  const sprint = fixture(), h = hostFixture();
  updateSprint(sprint.id, sprint.revision, (value) => { value.input.specification += "changed"; });
  await new SprintRunner(h.host).tick(sprint.id);
  expect(getSprint(sprint.id).status).toBe("needs_attention"); expect(h.launches).toEqual([]);
});

test("a failed prerequisite blocks descendants while unrelated work completes", async () => {
  const input = sprintFixture();
  input.tickets.push({ key: "OTHER", title: "Independent", prompt: "Independent feature", acceptance: ["Pass"], dependencies: [] });
  input.selected.push("OTHER");
  let sprint = createSprint(input);
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.specApproval = sprintSpecHash(value.input); value.batchApproval = sprintBatchHash(value.input); value.status = "running"; });
  const h = hostFixture();
  h.host.verify = async (_sprint, key) => { if (key === "LA-01") throw new Error("Root tests failed"); return `sha-${key}`; };
  for (let i = 0; i < 60; i++) await new SprintRunner(h.host).tick(sprint.id);
  expect(getSprint(sprint.id).state["LA-01"]!.status).toBe("failed");
  expect(getSprint(sprint.id).state.OTHER!.status).toBe("passed");
  expect(h.launches.some((id) => id.startsWith("LA-02:"))).toBe(false);
  expect(h.merges).toEqual(["OTHER"]);
  expect(getSprint(sprint.id).status).toBe("needs_attention");
});
