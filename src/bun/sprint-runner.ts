import { readySprintTickets, sprintCanShip, initialTicketState, SPRINT_LIMITS, type Sprint, type SprintTicket } from "../shared/sprint.ts";
import { quotaResetAt, requireSprintReview } from "../shared/sprint-result.ts";
import { getSprint, listSprints, sprintBatchHash, sprintSpecHash, updateSprint } from "./sprint-store.ts";

export interface SprintHost {
  prepare(sprint: Sprint): Promise<void>;
  capacity(): number;
  launch(sprint: Sprint, ticket: SprintTicket, role: "implement" | "review", candidate?: string): Promise<string>;
  poll(taskId: string): Promise<{ status: "running" | "success" | "failed"; output: string; result?: Record<string, unknown> }>;
  verify(sprint: Sprint, key: string): Promise<string>;
  integrate(sprint: Sprint, key: string): Promise<void>;
  finish(sprint: Sprint): Promise<"pending" | "completed">;
  cancel(sprint: Sprint): Promise<void>;
  stop(taskId: string): Promise<void>;
  notify(sprint: Sprint, message: string): void;
}

/** One lock per sprint; native core port ownership prevents concurrent cores.
 * Scheduling lives in the app, and workers are the existing native tasks. */
export class SprintRunner {
  private pending = new Set<string>();
  constructor(private host: SprintHost) {}

  async start(id: string, revision: number): Promise<Sprint> {
    if (this.pending.has(id)) throw new Error("Sprint operation already in progress");
    this.pending.add(id);
    try {
    const sprint = getSprint(id);
    if (sprint.revision !== revision || sprint.status !== "draft" || sprint.specApproval !== sprintSpecHash(sprint.input) || sprint.batchApproval !== sprintBatchHash(sprint.input)) throw new Error("Approve the current specification and exact batch before Run");
    await this.host.prepare(sprint);
    return updateSprint(id, getSprint(id).revision, (value) => {
      if (value.status !== "draft" || value.batchApproval !== sprintBatchHash(value.input) || value.specApproval !== sprintSpecHash(value.input)) throw new Error("Approval or pause state changed during preparation");
      value.status = "running"; value.error = null;
    });
    } finally { this.pending.delete(id); }
  }

  async pause(id: string, revision: number): Promise<Sprint> {
    const sprint = updateSprint(id, revision, (value) => { if (value.status === "completed") throw new Error("Sprint already completed"); value.status = "paused"; });
    await this.host.cancel(sprint);
    return updateSprint(id, getSprint(id).revision, (value) => {
      for (const [key, state] of Object.entries(value.state)) if (["implementing", "reviewing", "checking"].includes(state.status)) { state.status = "queued"; state.taskId = null; state.reviewTaskId = null; state.startedAt = null; if (key.startsWith("@")) state.attempts += 1; }
    });
  }

  async resume(id: string, revision: number): Promise<Sprint> {
    const sprint = getSprint(id);
    if (sprint.status === "paused" && !sprint.batchApproval && ["@plan", "@tickets"].some((key) => sprint.state[key]?.status === "queued")) return updateSprint(id, revision, (value) => { value.status = "draft"; value.error = null; });
    if (!["paused", "needs_attention", "waiting_quota"].includes(sprint.status) || sprint.batchApproval !== sprintBatchHash(sprint.input)) throw new Error("Approve changed inputs before resuming");
    return updateSprint(id, revision, (value) => { value.status = "running"; value.error = null; });
  }

  async tickAll(): Promise<void> {
    await Promise.all(listSprints().filter((sprint) => ["running", "verifying", "shipping", "waiting_quota"].includes(sprint.status)).map((sprint) => this.tick(sprint.id)));
  }

  async tick(id: string): Promise<void> {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    const patch = (mutate: (sprint: Sprint) => void) => updateSprint(id, getSprint(id).revision, mutate);
    try {
      let sprint = getSprint(id);
      if (["paused", "draft", "completed", "needs_attention"].includes(sprint.status)) return;
      if (sprint.batchApproval !== sprintBatchHash(sprint.input) || sprint.specApproval !== sprintSpecHash(sprint.input)) throw new Error("Approved requirements or agent settings changed; review the revision before continuing");
      if (sprint.status === "waiting_quota") {
        if (!Object.values(sprint.state).some((state) => state.retryAt && state.retryAt <= Date.now())) return;
        sprint = patch((value) => { value.status = "running"; });
      }
      if (sprint.status === "verifying" || sprint.status === "shipping") {
        if (!sprintCanShip(sprint)) throw new Error("Incomplete sprint cannot enter release");
        if (await this.host.finish(sprint) === "completed") {
          patch((value) => { value.status = "completed"; value.error = null; });
          this.host.notify(getSprint(id), "Sprint completed");
        }
        return;
      }

      for (const key of sprint.input.selected) {
        sprint = getSprint(id);
        if (sprint.status !== "running") return;
        const state = sprint.state[key]!, ticket = sprint.input.tickets.find((item) => item.key === key)!;
        if (!["implementing", "checking", "reviewing"].includes(state.status)) continue;
        try {
          if (state.status === "checking") {
            const candidate = await this.host.verify(sprint, key);
            if (getSprint(id).status !== "running") return;
            patch((value) => { const s = value.state[key]!; s.candidate = candidate; s.status = "reviewing"; s.startedAt = Date.now(); });
            continue;
          }
          if (state.status === "reviewing" && !state.reviewTaskId) {
            if (this.host.capacity() <= 0) continue;
            const taskId = await this.host.launch(sprint, ticket, "review", state.candidate!);
            patch((value) => { value.state[key]!.reviewTaskId = taskId; });
            continue;
          }
          if (state.status === "implementing" && !state.taskId) {
            if (this.host.capacity() <= 0) continue;
            const taskId = await this.host.launch(sprint, ticket, "implement");
            patch((value) => { value.state[key]!.taskId = taskId; });
            continue;
          }
          const taskId = state.status === "reviewing" ? state.reviewTaskId : state.taskId;
          if (!taskId) continue;
          const result = await this.host.poll(taskId);
          if (result.status === "running") {
            if (state.startedAt && Date.now() - state.startedAt > SPRINT_LIMITS.attemptMs) { await this.host.stop(taskId); throw new Error("20 minute attempt timeout"); }
            continue;
          }
          if (result.status === "failed") throw new Error(result.output || "Native task failed");
          if (result.result?.requiresApproval === true) throw new Error(`SPRINT_BLOCKER: ${String(result.result.reason ?? "Scope or architecture revision requires approval")}`);
          if (state.status === "implementing") patch((value) => { value.state[key]!.status = "checking"; });
          else {
            requireSprintReview(result.result ?? {}, state.candidate!);
            await this.host.integrate(sprint, key);
            patch((value) => { const s = value.state[key]!; s.status = "passed"; s.reviewed = s.candidate; s.error = null; });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const latest = getSprint(id);
          if (latest.status === "paused") return;
          if (message.startsWith("Agent capacity unavailable")) continue;
          if (message.startsWith("SPRINT_BLOCKER:")) throw error;
          if (/not logged in|authentication required|not installed|unknown included billing|subscription login required|profile not found|reviewer profile must|unsupported subscription route|model.*not (?:found|supported)|CLI.*(?:upgrade|too old)/i.test(message)) throw error;
          const retryAt = quotaResetAt(message, Date.now(), latest.state[key]!.quotaFailures);
          patch((value) => {
            const s = value.state[key]!;
            s.error = message;
            if (retryAt) {
              s.quotaFailures += 1;
              const reviewFallback = state.status === "reviewing" && !s.reviewFallback && value.input.profiles.planner && value.input.profiles.planner !== value.input.profiles.implementer && value.input.profiles.planner !== value.input.profiles.reviewer;
              const implementFallback = state.status === "implementing" && s.repairs === 0 && value.input.profiles.escalation;
              const fallback = (reviewFallback || implementFallback) && s.repairs < SPRINT_LIMITS.repairs;
              if (fallback) { s.repairs += 1; if (reviewFallback) s.reviewFallback = true; }
              s.status = "queued"; s.retryAt = fallback ? null : retryAt; s.taskId = null; s.reviewTaskId = null;
            }
            else if (s.repairs < SPRINT_LIMITS.repairs) { s.repairs += 1; s.status = "queued"; s.taskId = null; s.reviewTaskId = null; s.candidate = null; s.reviewed = null; }
            else s.status = "failed";
          });
          this.host.notify(getSprint(id), `${key}: ${message.slice(0, 200)}`);
        }
      }
      sprint = getSprint(id);
      for (const ticket of readySprintTickets(sprint)) {
        if (this.host.capacity() <= 0) break;
        patch((value) => { const state = value.state[ticket.key]!; state.status = state.candidate ? "reviewing" : "implementing"; state.startedAt = Date.now(); state.retryAt = null; state.attempts += 1; });
      }
      sprint = getSprint(id);
      if (sprintCanShip(sprint)) patch((value) => { value.status = "verifying"; });
      else if (!Object.values(sprint.state).some((state) => ["implementing", "checking", "reviewing"].includes(state.status)) && readySprintTickets(sprint).length === 0) {
        if (Object.values(sprint.state).some((state) => state.retryAt && state.retryAt > Date.now())) patch((value) => { value.status = "waiting_quota"; });
        else { patch((value) => { value.status = "needs_attention"; value.error = "Failed tickets block their dependents. Completed work and repair budgets are preserved."; }); this.host.notify(getSprint(id), "Sprint needs attention"); }
      }
    } catch (error) {
      if (getSprint(id).status !== "paused") {
        patch((value) => { value.status = "needs_attention"; value.error = error instanceof Error ? error.message : String(error); });
        await this.host.cancel(getSprint(id));
        this.host.notify(getSprint(id), getSprint(id).error!);
      }
    } finally { this.pending.delete(id); }
  }
}
