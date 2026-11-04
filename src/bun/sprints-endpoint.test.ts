import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-api-"));
process.env.AGETOR_API_PORT = "4786";
const { sprintFixture } = await import("../test-sprint-fixture.ts");
let server: { stop: () => void }, master: string, cli: string;
beforeAll(async () => {
  const api = await import("./server.ts");
  const credentials = await import("./api-config.ts");
  server = api.startApiServer() as unknown as { stop: () => void };
  master = credentials.API_TOKEN; cli = credentials.CLI_TOKEN;
});
afterAll(() => server?.stop());
function call(url: string, token: string, method = "GET", body?: unknown) {
  return fetch(`http://127.0.0.1:4786${url}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("CLI callers can read sprint records but cannot create, edit, approve or run them", async () => {
  const created = await call("/sprints", master, "POST", sprintFixture());
  expect(created.status).toBe(201);
  const sprint = await created.json() as { id: string; revision: number };
  expect((await call(`/sprints/${sprint.id}`, cli)).status).toBe(200);
  expect((await call("/sprints", cli, "POST", sprintFixture())).status).toBe(403);
  expect((await call(`/sprints/${sprint.id}`, cli, "PATCH", { revision: sprint.revision, input: sprintFixture() })).status).toBe(403);
  for (const action of ["approve-spec", "approve-batch", "run", "resume", "plan", "tickets"]) expect((await call(`/sprints/${sprint.id}/actions`, cli, "POST", { revision: sprint.revision, action })).status).toBe(403);
  expect((await call(`/sprints/${sprint.id}/actions`, master, "POST", { revision: sprint.revision, action: "run" })).status).toBe(409);
});
test("HTTP edits require the current revision and do not accept forged approval state", async () => {
  const created = await call("/sprints", master, "POST", { ...sprintFixture(), batchApproval: "forged", status: "completed" });
  const sprint = await created.json() as { id: string; revision: number; status: string; batchApproval: unknown };
  expect(sprint.status).toBe("draft"); expect(sprint.batchApproval).toBeNull();
  const approved = await call(`/sprints/${sprint.id}/actions`, master, "POST", { revision: sprint.revision, action: "approve-spec" });
  expect(approved.status).toBe(200);
  expect((await call(`/sprints/${sprint.id}`, master, "PATCH", { revision: sprint.revision, input: sprintFixture() })).status).toBe(409);
});
test("sprint profile setup is idempotent and managed workers cannot be started or rebound through the ordinary task API", async () => {
  const response = await call("/sprints", master, "POST", sprintFixture());
  let sprint = await response.json() as import("../shared/sprint.ts").Sprint;
  // Fixture placeholder IDs are unresolved, so setup creates the five profiles.
  const first = await call(`/sprints/${sprint.id}/actions`, master, "POST", { revision: sprint.revision, action: "setup-agents" });
  expect(first.status).toBe(200); sprint = await first.json() as typeof sprint;
  const profiles = structuredClone(sprint.input.profiles);
  const second = await call(`/sprints/${sprint.id}/actions`, master, "POST", { revision: sprint.revision, action: "setup-agents" });
  expect(second.status).toBe(200);
  expect((await second.json() as typeof sprint).input.profiles).toEqual(profiles);
  const { createTask } = await import("./orchestrator.ts");
  const { bindSprintTask } = await import("./db.ts");
  const created = await createTask({ title: "Managed fixture", prompt: "Do not run", agent: "claude-code", workdir: process.cwd(), isolation: "none" });
  if ("error" in created) throw new Error(created.error);
  bindSprintTask(created.task.id, sprint.id, "implement:LA-01");
  const start = await call(`/tasks/${created.task.id}/start`, master, "POST", {});
  expect(start.ok).toBe(false); expect((await start.json() as { error: string }).error).toContain("managed by a sprint");
  expect((await call(`/tasks/${created.task.id}`, master, "PATCH", { model: "unapproved" })).status).toBe(409);
  expect((await call(`/tasks/${created.task.id}`, master, "DELETE")).status).toBe(409);
  expect((await call(`/tasks/${created.task.id}/agent-profile`, cli, "DELETE")).status).toBe(409);
});

test("batch approval reports missing delivery settings and succeeds after saving a local delivery", async () => {
  const input = sprintFixture();
  input.shipping.requiredChecks = [];
  let response = await call("/sprints", master, "POST", input);
  let sprint = await response.json() as import("../shared/sprint.ts").Sprint;
  const action = async (name: string) => call("/sprints/" + sprint.id + "/actions", master, "POST", { revision: sprint.revision, action: name });
  response = await action("setup-agents");
  expect(response.status).toBe(200);
  sprint = await response.json() as typeof sprint;
  response = await action("approve-spec");
  expect(response.status).toBe(200);
  sprint = await response.json() as typeof sprint;
  const specApproval = sprint.specApproval;
  response = await action("approve-batch");
  expect(response.status).toBe(409);
  expect((await response.json() as { error: string }).error).toContain("exact required CI check names");
  response = await call("/sprints/" + sprint.id, master, "PATCH", { revision: sprint.revision, input: { ...sprint.input, shipping: { ...sprint.input.shipping, enabled: false } } });
  expect(response.status).toBe(200);
  sprint = await response.json() as typeof sprint;
  expect(sprint.specApproval).toBe(specApproval);
  response = await action("approve-batch");
  expect(response.status).toBe(200);
  sprint = await response.json() as typeof sprint;
  expect(sprint.batchApproval).toBeTruthy();
  expect(sprint.status).toBe("draft");
  expect(sprint.integrationTaskId).toBeNull();
});
