import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-planning-"));
let notifications: string | undefined;
beforeEach(() => { notifications = process.env.AGETOR_HEADLESS_NOTIFICATIONS; process.env.AGETOR_HEADLESS_NOTIFICATIONS = "0"; });
afterEach(() => { if (notifications === undefined) delete process.env.AGETOR_HEADLESS_NOTIFICATIONS; else process.env.AGETOR_HEADLESS_NOTIFICATIONS = notifications; });
const { createSprint, approveSprintSpec, editSprint, getSprint, updateSprint } = await import("./sprint-store.ts");
const { tickDraft } = await import("./sprint-controller.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
const { initialTicketState } = await import("../shared/sprint.ts");

test("a stale queued ticket-generation request cannot launch without current specification approval", async () => {
  let sprint = createSprint(sprintFixture());
  sprint = approveSprintSpec(sprint.id, sprint.revision);
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.input.specification += " Changed scope.";
    value.state["@tickets"] = { ...initialTicketState(), status: "queued", attempts: 2 };
  });
  let calls = 0;
  await tickDraft(sprint, async () => { calls++; return null; });
  const final = getSprint(sprint.id);
  expect(calls).toBe(0);
  expect(final.status).toBe("needs_attention");
  expect(final.error).toContain("Approve the current specification");
});

test("a late planning result cannot replace an edited draft after pause", async () => {
  let sprint = createSprint(sprintFixture());
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.state["@plan"] = { ...initialTicketState(), status: "implementing", attempts: 1 };
  });
  await tickDraft(sprint, async () => {
    const current = getSprint(sprint.id);
    const paused = updateSprint(current.id, current.revision, (value) => {
      value.status = "paused";
      value.state["@plan"]!.status = "queued";
    });
    editSprint(paused.id, paused.revision, { ...paused.input, specification: "My revised specification" });
    return { status: "success", output: "", result: { specification: "Stale generated specification" } };
  });
  const final = getSprint(sprint.id);
  expect(final.status).toBe("draft");
  expect(final.input.specification).toBe("My revised specification");
  expect(final.state["@plan"]!.status).toBe("failed");
});
