import { createHash, randomUUID } from "node:crypto";
import { db, agentProfiles, harnesses } from "./db.ts";
import { initialTicketState, validateSprintInput, type Sprint, type SprintInput } from "../shared/sprint.ts";

export function sprintSpecHash(input: SprintInput): string {
  return createHash("sha256").update(JSON.stringify([input.workdir, input.prompt, input.specification])).digest("hex");
}

/** Captures actual profile settings as well as IDs. Editing a saved profile invalidates a batch. */
export function sprintBatchHash(input: SprintInput): string {
  const profiles = Object.values(input.profiles).map((id) => id ? agentProfiles.get(id) : null);
  const routes = profiles.map((profile) => {
    const harness = profile ? harnesses.get(profile.harness) : null;
    return harness ? { id: harness.id, kind: harness.kind, home: harness.home, bin: harness.bin, env: harness.env, enabled: harness.enabled } : null;
  });
  return createHash("sha256").update(JSON.stringify({ input, profiles, routes })).digest("hex");
}

export function getSprint(id: string): Sprint {
  const row = db.query<{ payload: string }, [string]>("SELECT payload FROM sprints WHERE id = ?").get(id);
  if (!row) throw new Error("Sprint not found");
  return JSON.parse(row.payload) as Sprint;
}

export function listSprints(): Sprint[] {
  return db.query<{ payload: string }, []>("SELECT payload FROM sprints ORDER BY updated_at DESC").all().map((row) => JSON.parse(row.payload) as Sprint);
}

export function createSprint(raw: unknown): Sprint {
  const input = validateSprintInput(raw), now = Date.now();
  const sprint: Sprint = {
    id: randomUUID(), revision: 1, input, status: "draft", specApproval: null, batchApproval: null,
    state: Object.fromEntries(input.tickets.map((ticket) => [ticket.key, initialTicketState()])),
    branch: null, integrationTaskId: null, planningTaskId: null, ticketingTaskId: null,
    prUrl: null, mergeSha: null, error: null, createdAt: now, updatedAt: now,
  };
  db.run("INSERT INTO sprints (id, revision, payload, updated_at) VALUES (?, ?, ?, ?)", [sprint.id, sprint.revision, JSON.stringify(sprint), now]);
  return sprint;
}

/** Synchronous transaction, never held across a Git/process/HTTP operation. */
export function updateSprint(id: string, revision: number, mutate: (sprint: Sprint) => void): Sprint {
  return db.transaction(() => {
    const sprint = getSprint(id);
    if (sprint.revision !== revision) throw new Error("Sprint changed; reload before retrying");
    mutate(sprint);
    sprint.revision += 1; sprint.updatedAt = Date.now();
    const result = db.run("UPDATE sprints SET revision = ?, payload = ?, updated_at = ? WHERE id = ? AND revision = ?", [sprint.revision, JSON.stringify(sprint), sprint.updatedAt, id, revision]);
    if (result.changes !== 1) throw new Error("Concurrent sprint update");
    return sprint;
  })();
}

export function editSprint(id: string, revision: number, raw: unknown): Sprint {
  const input = validateSprintInput(raw);
  return updateSprint(id, revision, (sprint) => {
    if (!["draft", "paused", "needs_attention"].includes(sprint.status)) throw new Error("Pause the sprint before editing requirements");
    if (Object.values(sprint.state).some((state) => ["implementing", "checking", "reviewing"].includes(state.status))) throw new Error("Wait for active workers to stop before editing");
    if (sprint.mergeSha) throw new Error("A shipped sprint is immutable");
    const specUnchanged = sprintSpecHash(sprint.input) === sprintSpecHash(input);
    const sameBatch = (sprint.batchApproval ?? sprintBatchHash(sprint.input)) === sprintBatchHash(input);
    sprint.input = input;
    if (!specUnchanged) sprint.specApproval = null;
    if (!sameBatch) {
      sprint.batchApproval = null;
      // Keep the attempt ledger, but require new code verification/review after a revision.
      const keys = new Set([...Object.keys(sprint.state), ...input.tickets.map((ticket) => ticket.key)]);
      sprint.state = Object.fromEntries([...keys].map((key) => [key, { ...initialTicketState(), repairs: sprint.state[key]?.repairs ?? 0, attempts: (sprint.state[key]?.attempts ?? 0) + (key.startsWith("@") ? 1 : 0), quotaFailures: sprint.state[key]?.quotaFailures ?? 0 }]));
      sprint.releasePollAt = 0;
      sprint.status = "draft";
    }
  });
}

export function approveSprintSpec(id: string, revision: number): Sprint {
  return updateSprint(id, revision, (sprint) => {
    if (sprint.status !== "draft" || !sprint.input.specification.trim()) throw new Error("A draft specification is required");
    sprint.specApproval = sprintSpecHash(sprint.input);
  });
}

export function approveSprintBatch(id: string, revision: number): Sprint {
  return updateSprint(id, revision, (sprint) => {
    if (sprint.status !== "draft" || sprint.specApproval !== sprintSpecHash(sprint.input)) throw new Error("Approve the current specification first");
    if (!sprint.input.selected.length || !sprint.input.checks.length || !sprint.input.includedOnly) throw new Error("Select tickets, configure checks and confirm included capacity only");
    for (const id of Object.values(sprint.input.profiles).filter(Boolean) as string[]) if (!agentProfiles.get(id)) throw new Error(`Agent profile not found: ${id}`);
    const p = sprint.input.profiles;
    if (!p.implementer || !p.reviewer || p.implementer === p.reviewer) throw new Error("Choose implementation and independent review profiles");
    if (sprint.input.shipping.enabled && (!sprint.input.shipping.repository || !sprint.input.shipping.requiredChecks.length)) throw new Error("Shipping requires a repository and named CI checks");
    sprint.batchApproval = sprintBatchHash(sprint.input);
  });
}
