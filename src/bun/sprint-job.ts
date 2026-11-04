import { createTask, cancelLiveRunOfTask } from "./orchestrator.ts";
import { tasks, runs, bindSprintTask } from "./db.ts";
import { getSprint, sprintSpecHash, updateSprint } from "./sprint-store.ts";
import { nativeSprintPoll, startSprintTask } from "./sprint-native.ts";
import { initialTicketState, SPRINT_LIMITS, type Sprint } from "../shared/sprint.ts";
import { quotaResetAt } from "../shared/sprint-result.ts";

function fallbackFor(sprint: Sprint, role: string): string | null {
  const profiles = sprint.input.profiles;
  if (role === "plan") return profiles.tickets || null;
  if (role === "tickets") return profiles.planner || null;
  if (role === "review") return profiles.planner && profiles.planner !== profiles.implementer ? profiles.planner : null;
  return role === "implement" ? profiles.escalation : null;
}

/** Model jobs use native task identities and durable counters just like ticket workers. */
export async function sprintJob(sprint: Sprint, key: string, profileId: string, cwd: string, prompt: string, role: string): Promise<Awaited<ReturnType<typeof nativeSprintPoll>> | null> {
  let current = getSprint(sprint.id);
  if (current.status === "paused") return null;
  let state = current.state[key];
  if (!state) {
    current = updateSprint(current.id, current.revision, (value) => { value.state[key] = { ...initialTicketState(), status: "implementing", startedAt: Date.now(), attempts: 1 }; });
    state = current.state[key]!;
  }
  if (state.retryAt && state.retryAt > Date.now()) return null;
  const attempt = state.attempts;
  const generation = role === "plan" || role === "tickets";
  const mayStart = (value: Sprint) => value.state[key]?.attempts === attempt && (generation
    ? value.status === "draft" && ["queued", "implementing"].includes(value.state[key]?.status ?? "") && (role !== "tickets" || value.specApproval === sprintSpecHash(value.input))
    : ["verifying", "shipping"].includes(value.status) && !!value.batchApproval);
  if (!mayStart(current)) return null;
  const fallbackProfile = state.repairs > 0 ? fallbackFor(current, role) : null;
  const effectiveProfile = fallbackProfile || profileId;
  const title = `[sprint:${sprint.id}:job:${key}:${state.attempts}]`;
  let task = state.taskId ? tasks.get(state.taskId) : tasks.list().find((item) => item.title === title);
  if (!task) {
    const result = await createTask({ title, prompt: `${prompt}\nPrevious job failure: ${state.error ?? "none"}\nIf scope or architecture must change, stop and return one <sprint-result>{"requiresApproval":true,"reason":"decision required"}</sprint-result>.`, agentProfileId: effectiveProfile, workdir: cwd, isolation: role === "plan" || role === "tickets" ? "worktree" : "none" });
    if ("error" in result) throw new Error(result.error);
    task = result.task;
    bindSprintTask(task.id, sprint.id, `job:${key}`);
    current = getSprint(sprint.id);
    if (!mayStart(current)) return null;
    updateSprint(current.id, current.revision, (value) => { value.state[key]!.taskId = task!.id; });
  }
  if (runs.countForTask(task.id) === 0) {
    current = getSprint(sprint.id);
    updateSprint(current.id, current.revision, (value) => { value.state[key]!.startedAt = Date.now(); value.state[key]!.status = "implementing"; });
  }
  bindSprintTask(task.id, sprint.id, `job:${key}`);
  try {
  await startSprintTask(getSprint(sprint.id), task, effectiveProfile, role, mayStart);
  const result = await nativeSprintPoll(task.id);
  if (result.status === "running") {
    if (state.startedAt && Date.now() - state.startedAt > SPRINT_LIMITS.attemptMs) { await cancelLiveRunOfTask(task.id); throw new Error("20 minute model job timeout"); }
    return null;
  }
  if (result.status === "failed") throw new Error(result.output);
  if (result.result?.requiresApproval === true) throw new Error(`SPRINT_BLOCKER: ${String(result.result.reason ?? "A requirements revision needs approval")}`);
  return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Agent capacity unavailable")) return null;
    if (message.startsWith("SPRINT_BLOCKER:")) throw error;
    if (!mayStart(getSprint(sprint.id))) return null;
    const retry = quotaResetAt(message, Date.now(), state.quotaFailures);
    if (!retry) throw error;
    current = getSprint(sprint.id);
    updateSprint(current.id, current.revision, (value) => {
      const next = value.state[key]!, fallback = fallbackFor(value, role);
      next.quotaFailures += 1;
      const budget = key.startsWith("@final") && value.state["@final"] ? value.state["@final"]! : next;
      const useFallback = next.repairs === 0 && budget.repairs < 3 && fallback && fallback !== profileId;
      if (useFallback) { next.repairs += 1; if (budget !== next) budget.repairs += 1; }
      next.status = "queued"; next.retryAt = useFallback ? null : retry; next.taskId = null; next.startedAt = null; next.attempts += 1; next.error = message; value.error = message;
    });
    return null;
  }
}
