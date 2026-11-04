import { describe, expect, test } from "bun:test";
import { initialTicketState, readySprintTickets, sprintCanShip, validateSprintInput, sprintTicketMarkdown, selectedSprintTickets, preserveSprintBacklog, type SprintInput, type Sprint } from "./sprint.ts";

import { sprintFixture } from "../test-sprint-fixture.ts";

function running(): Sprint {
  const input = sprintFixture();
  return { id: "test", revision: 1, input, status: "running", specApproval: "spec", batchApproval: "batch", state: Object.fromEntries(input.tickets.map((ticket) => [ticket.key, initialTicketState()])), branch: null, integrationTaskId: null, planningTaskId: null, ticketingTaskId: null, prUrl: null, mergeSha: null, error: null, createdAt: 0, updatedAt: 0 };
}
describe("sprint graph and execution gates", () => {
  test("versioned backlog is retained while final review includes only selected tickets", () => {
    const input = sprintFixture(); input.selected = ["LA-01"];
    expect(selectedSprintTickets(input).map((ticket) => ticket.key)).toEqual(["LA-01"]);
    expect(sprintTicketMarkdown(input)).toContain("# LA-08: Save\n\nExecution: backlog only; do not execute");
    const updated = { ...input.tickets[0]!, title: "Revised foundation" };
    const regenerated = validateSprintInput({ ...input, tickets: preserveSprintBacklog(input.tickets, [updated]) });
    expect(regenerated.tickets).toHaveLength(4);
    expect(regenerated.tickets.find((ticket) => ticket.key === "LA-01")!.title).toBe("Revised foundation");
    expect(regenerated.tickets.find((ticket) => ticket.key === "LA-08")).toBeDefined();
    expect(() => validateSprintInput({ ...input, tickets: preserveSprintBacklog(input.tickets, undefined) })).toThrow();
  });
  test("accepts the pilot graph and preserves LA identifiers", () => expect(validateSprintInput(sprintFixture()).selected).toEqual(["LA-01", "LA-02", "LA-03", "LA-08"]));
  test("rejects cycles, missing dependencies, duplicate keys and unselected prerequisites", () => {
    let input = sprintFixture(); input.tickets[0]!.dependencies = ["LA-03"]; expect(() => validateSprintInput(input)).toThrow("cycle");
    input = sprintFixture(); input.tickets[0]!.dependencies = ["missing"]; expect(() => validateSprintInput(input)).toThrow("Unknown dependency");
    input = sprintFixture(); input.tickets[1]!.key = "LA-01"; expect(() => validateSprintInput(input)).toThrow("Duplicate");
    input = sprintFixture(); input.selected = ["LA-03"]; expect(() => validateSprintInput(input)).toThrow("prerequisite");
  });
  test("prerequisites must pass review on the exact candidate", () => {
    const sprint = running();
    expect(readySprintTickets(sprint).map((ticket) => ticket.key)).toEqual(["LA-01"]);
    sprint.state["LA-01"] = { ...initialTicketState(), status: "passed", candidate: "new", reviewed: "old" };
    expect(readySprintTickets(sprint)).toEqual([]);
    sprint.state["LA-01"]!.reviewed = "new";
    expect(readySprintTickets(sprint).map((ticket) => ticket.key)).toEqual(["LA-02"]);
    sprint.state["LA-02"] = { ...initialTicketState(), status: "passed", candidate: "contracts", reviewed: "contracts" };
    expect(readySprintTickets(sprint).map((ticket) => ticket.key)).toEqual(["LA-03", "LA-08"]);
  });
  test("pause, missing approval and failed prerequisites block scheduling", () => {
    const sprint = running(); sprint.status = "paused"; expect(readySprintTickets(sprint)).toEqual([]);
    sprint.status = "running"; sprint.batchApproval = null; expect(readySprintTickets(sprint)).toEqual([]);
    sprint.batchApproval = "approved"; sprint.state["LA-01"]!.status = "failed"; expect(readySprintTickets(sprint)).toEqual([]);
  });
  test("quota cooldown is honored and no incomplete sprint can ship", () => {
    const sprint = running(); sprint.state["LA-01"]!.retryAt = 100;
    expect(readySprintTickets(sprint, 99)).toEqual([]); expect(readySprintTickets(sprint, 100)).toHaveLength(1);
    expect(sprintCanShip(sprint)).toBe(false);
    for (const state of Object.values(sprint.state)) Object.assign(state, { status: "passed", candidate: "sha", reviewed: "sha" });
    expect(sprintCanShip(sprint)).toBe(true);
    sprint.state["LA-08"]!.reviewed = "stale"; expect(sprintCanShip(sprint)).toBe(false);
  });
  test("concurrency budget includes verification and review", () => {
    const sprint = running();
    for (const key of ["LA-02", "LA-03", "LA-08"]) sprint.state[key]!.status = "reviewing";
    expect(readySprintTickets(sprint)).toEqual([]);
  });
});
