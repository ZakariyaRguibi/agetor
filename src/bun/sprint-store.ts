import { createHash, randomUUID } from "node:crypto";
import { db, agentProfiles, harnesses } from "./db.ts";
import { initialTicketState, sprintApprovalIssues, SPRINT_DRAFT_JOBS, validateSprintInput, type Sprint, type SprintInput } from "../shared/sprint.ts";

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
      sprint.state = Object.fromEntries([...keys].map((key) => {
        const previous = sprint.state[key];
        if (previous && (key === "@plan" || key === "@tickets")) return [key, previous];
        return [key, { ...initialTicketState(), repairs: previous?.repairs ?? 0, attempts: (previous?.attempts ?? 0) + (key.startsWith("@") ? 1 : 0), quotaFailures: previous?.quotaFailures ?? 0 }];
      }));
      sprint.releasePollAt = 0;
      sprint.status = "draft";
    }
    // `queued` is runnable for generation jobs. A save must never create
    // or resume that authorization, even when editing a paused draft.
    for (const key of SPRINT_DRAFT_JOBS) {
      const job = sprint.state[key];
      if (job?.status === "queued") Object.assign(job, { status: "failed", retryAt: null, startedAt: null, error: "Generation stopped when the draft was saved. Use Generate to request it again." });
    }
    if (!sprint.integrationTaskId && ["paused", "needs_attention"].includes(sprint.status)) {
      sprint.status = "draft";
      sprint.error = null;
    }
  });
}

export function approveSprintSpec(id: string, revision: number): Sprint {
  return updateSprint(id, revision, (sprint) => {
    if (sprint.status !== "draft" || !sprint.input.specification.trim()) throw new Error("A draft specification is required");
    assertNoPendingGeneration(sprint);
    sprint.specApproval = sprintSpecHash(sprint.input);
  });
}

export function approveSprintBatch(id: string, revision: number): Sprint {
  return updateSprint(id, revision, (sprint) => {
    if (sprint.status !== "draft") throw new Error("Save the sprint as a draft before approving a batch");
    assertNoPendingGeneration(sprint);
    const issues = sprintApprovalIssues(sprint.input, sprint.specApproval === sprintSpecHash(sprint.input), (id) => !!agentProfiles.get(id));
    if (issues.length) throw new Error(issues.join(" "));
    sprint.batchApproval = sprintBatchHash(sprint.input);
  });
}

function assertNoPendingGeneration(sprint: Sprint): void {
  if (SPRINT_DRAFT_JOBS.some((key) => ["queued", "implementing"].includes(sprint.state[key]?.status ?? ""))) throw new Error("Wait for specification or ticket generation to finish before approving");
}
