import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprints-"));
const { createSprint, editSprint, updateSprint, getSprint, approveSprintSpec, sprintSpecHash } = await import("./sprint-store.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
const { initialTicketState } = await import("../shared/sprint.ts");

test("sprint updates are versioned, stale writers fail and repair budgets survive revisions", () => {
  let sprint = createSprint(sprintFixture());
  expect(getSprint(sprint.id)).toEqual(sprint);
  sprint = approveSprintSpec(sprint.id, sprint.revision);
  expect(sprint.specApproval).toBe(sprintSpecHash(sprint.input));
  expect(() => approveSprintSpec(sprint.id, 1)).toThrow("reload");
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.state["LA-01"]!.repairs = 2; });
  const input = structuredClone(sprint.input); input.specification += "\nChanged requirements";
  sprint = editSprint(sprint.id, sprint.revision, input);
  expect(sprint.specApproval).toBeNull(); expect(sprint.batchApproval).toBeNull();
  expect(sprint.state["LA-01"]!.repairs).toBe(2);
});

test("running requirements cannot be edited and transaction failures leave revision unchanged", () => {
  let sprint = createSprint(sprintFixture());
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.status = "running"; });
  expect(() => editSprint(sprint.id, sprint.revision, sprint.input)).toThrow("Pause");
  expect(getSprint(sprint.id).revision).toBe(sprint.revision);
});

test("revised batches preserve retired ticket budgets and advance job identities", () => {
  let sprint = createSprint(sprintFixture());
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.batchApproval = "stale-profile-hash"; value.status = "paused";
    value.state["LA-08"]!.repairs = 3;
    value.state["@docs"] = { ...initialTicketState(), status: "passed", attempts: 4, repairs: 2, taskId: "old-job" };
  });
  sprint = editSprint(sprint.id, sprint.revision, sprint.input);
  expect(sprint.status).toBe("draft"); expect(sprint.batchApproval).toBeNull();
  expect(sprint.state["@docs"]!.taskId).toBeNull(); expect(sprint.state["@docs"]!.attempts).toBe(5);
  const withoutSave = structuredClone(sprint.input); withoutSave.tickets = withoutSave.tickets.filter((ticket) => ticket.key !== "LA-08"); withoutSave.selected = withoutSave.selected.filter((key) => key !== "LA-08");
  const original = structuredClone(sprint.input);
  sprint = editSprint(sprint.id, sprint.revision, withoutSave);
  sprint = editSprint(sprint.id, sprint.revision, original);
  expect(sprint.state["LA-08"]!.repairs).toBe(3);
});

test("saving delivery settings retains completed generation and specification approval", () => {
  let sprint = createSprint(sprintFixture());
  sprint = approveSprintSpec(sprint.id, sprint.revision);
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.state["@plan"] = { ...initialTicketState(), status: "passed", attempts: 1, taskId: "finished-plan" };
    value.state["@tickets"] = { ...initialTicketState(), status: "passed", attempts: 1, taskId: "finished-tickets" };
  });
  const input = structuredClone(sprint.input); input.shipping.enabled = false;
  const saved = editSprint(sprint.id, sprint.revision, input);
  expect(saved.specApproval).toBe(sprint.specApproval);
  expect(saved.state["@plan"]).toEqual(sprint.state["@plan"]!);
  expect(saved.state["@tickets"]).toEqual(sprint.state["@tickets"]!);
});

test("saving a paused pre-run draft cancels pending generation without resetting its ledger", () => {
  let sprint = createSprint(sprintFixture());
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.status = "paused";
    value.state["@tickets"] = { ...initialTicketState(), status: "queued", attempts: 4, repairs: 2, retryAt: Date.now() + 1000 };
  });
  const saved = editSprint(sprint.id, sprint.revision, sprint.input);
  expect(saved.status).toBe("draft");
  expect(saved.state["@tickets"]!.status).toBe("failed");
  expect(saved.state["@tickets"]!.retryAt).toBeNull();
  expect(saved.state["@tickets"]!.attempts).toBe(4);
  expect(saved.state["@tickets"]!.repairs).toBe(2);
  expect(() => approveSprintSpec(saved.id, saved.revision)).not.toThrow();
});
