import { initialTicketState, validateSprintInput, preserveSprintBacklog, type Sprint } from "../shared/sprint.ts";
import { quotaResetAt } from "../shared/sprint-result.ts";
import { createTaskNotifier, type TaskNotification } from "./task-notifier.ts";
import { getSprint, listSprints, updateSprint } from "./sprint-store.ts";
import { nativeSprintHost } from "./sprint-native.ts";
import { SprintRunner } from "./sprint-runner.ts";
import { finishSprint } from "./sprint-release.ts";
import { sprintJob } from "./sprint-job.ts";
import { activeRunCount, cancelLiveRunOfTask } from "./orchestrator.ts";
import { recoverSprintCommands } from "./sprint-command.ts";
import { agentProfiles } from "./db.ts";

const notifier = createTaskNotifier({ plain: () => {} });
let postNotice = (notice: TaskNotification) => { if (process.env.AGETOR_HEADLESS_NOTIFICATIONS !== "0") notifier.post(notice); };
const host = nativeSprintHost(finishSprint);
host.notify = (sprint, message) => {
  const current = getSprint(sprint.id), notice = `${current.status}:${message.slice(0, 2000)}`;
  if (current.lastNotice === notice) return;
  updateSprint(current.id, current.revision, (value) => { value.lastNotice = notice; });
  postNotice({ title: sprint.status === "completed" ? "Sprint completed" : "Sprint needs attention", body: `${sprint.input.name}: ${message}`.slice(0, 400), taskId: sprint.integrationTaskId ?? sprint.id, kind: sprint.status === "completed" ? "succeeded" : "blocked" });
};
export const sprintRunner = new SprintRunner(host);
let timer: ReturnType<typeof setInterval> | null = null;
const jobs = new Set<string>();
const deadlines = new Map<string, ReturnType<typeof setTimeout>>();

function armDeadlines(sprint: Sprint) {
  for (const state of Object.values(sprint.state)) {
    if (!["implementing", "reviewing"].includes(state.status) || !state.startedAt) continue;
    for (const id of [state.taskId, state.reviewTaskId].filter((value): value is string => !!value)) {
      if (deadlines.has(id)) continue;
      const timeout = setTimeout(() => { void cancelLiveRunOfTask(id); deadlines.delete(id); }, Math.max(1, state.startedAt + 20 * 60_000 - Date.now()));
      timeout.unref(); deadlines.set(id, timeout);
    }
  }
}

async function tickDraft(sprint: Sprint): Promise<void> {
  if (jobs.has(sprint.id)) return;
  const key = ["@plan", "@tickets"].find((name) => sprint.state[name]?.status === "implementing" || sprint.state[name]?.status === "queued");
  if (!key || sprint.status !== "draft") return;
  const state = sprint.state[key]!;
  if (state.retryAt && state.retryAt > Date.now() || activeRunCount() >= 3) return;
  jobs.add(sprint.id);
  try {
    const planning = key === "@plan", profileId = planning ? sprint.input.profiles.planner : sprint.input.profiles.tickets;
    const prompt = planning
      ? `Develop a sprint specification and architecture for the following product prompt. Inspect the repository but do not implement, publish or delegate. Explain acceptance criteria, scope boundaries, important decisions, risks and verification. Return exactly one <sprint-result>{"specification":"complete Markdown specification"}</sprint-result>. If a consequential decision requires the user, include it clearly as an open question.\nProduct prompt:\n${sprint.input.prompt}\nExisting specification:\n${sprint.input.specification}`
      : `Convert the approved specification into detailed, independently executable backlog tickets. Preserve existing ticket keys and planning context. Include acceptance criteria, implementation boundaries, verification and explicit dependencies. Propose repository-appropriate install, test, lint, type-check, build and smoke commands, with browser checks for UI changes. Commands are argv arrays without shell expansion. Do not implement, start tasks, publish or delegate. Return exactly one <sprint-result>{"tickets":[{"key":"stable identifier","title":"title","prompt":"self-contained detailed instructions","acceptance":["testable criterion"],"dependencies":[]}],"checks":[{"name":"Tests","argv":["program","argument"]}]}</sprint-result>.\nApproved specification:\n${sprint.input.specification}\nExisting tickets:\n${JSON.stringify(sprint.input.tickets)}`;
    const result = await sprintJob(sprint, key, profileId, sprint.input.workdir, prompt, planning ? "plan" : "tickets");
    if (!result) return;
    const current = getSprint(sprint.id);
    if (current.status === "paused") return;
    const input = validateSprintInput({ ...current.input, ...(planning ? { specification: result.result?.specification } : { tickets: preserveSprintBacklog(current.input.tickets, result.result?.tickets), checks: current.input.checks.length ? current.input.checks : result.result?.checks ?? [] }) });
    updateSprint(current.id, current.revision, (value) => {
      value.input = input; value.batchApproval = null; value.status = "draft"; value.error = null;
      if (planning) value.specApproval = null;
      for (const ticket of input.tickets) value.state[ticket.key] ??= initialTicketState();
      value.state[key]!.status = "passed";
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error), current = getSprint(sprint.id);
    if (current.status === "paused") return;
    updateSprint(current.id, current.revision, (value) => {
      const state = value.state[key]!, retry = quotaResetAt(message, Date.now(), state.repairs);
      state.error = message; value.error = message;
      if (retry) { state.status = "queued"; state.retryAt = retry; state.taskId = null; state.attempts += 1; state.startedAt = null; }
      else { state.status = "failed"; value.status = "needs_attention"; }
    });
    host.notify(getSprint(sprint.id), message);
  } finally { jobs.delete(sprint.id); }
}

export async function sprintControl(id: string, revision: number, action: string): Promise<Sprint> {
  if (action === "setup-agents") return updateSprint(id, revision, (value) => {
    if (value.status !== "draft") throw new Error("Create agent profiles before approving and running the sprint");
    const defaults = {
      planner: { harness: "claude-code", model: "sonnet", mode: "plan" },
      tickets: { harness: "codex", model: "gpt-6.1-sol", mode: "ask" },
      implementer: { harness: "opencode", model: "opencode-go/deepseek-v4.1-flash", mode: "auto" },
      reviewer: { harness: "codex", model: "gpt-6.1-sol", mode: "ask" },
      escalation: { harness: "codex", model: "gpt-6.1-terra", mode: "auto" },
    } as const;
    for (const role of Object.keys(defaults) as Array<keyof typeof defaults>) {
      const existing = value.input.profiles[role];
      if (existing && agentProfiles.get(existing)) continue;
      const base = `${Array.from(value.input.name).slice(0, 25).join("")} · ${role} (${id.slice(0, 8)})`;
      let name = base, n = 2; const names = new Set(agentProfiles.list().map((profile) => profile.name));
      while (names.has(name)) name = `${base} ${n++}`;
      const profile = agentProfiles.insert({ name, ...defaults[role], effort: "medium", speed: "off", maxMode: false, opencodeServer: "standalone", instructions: "", skills: [] });
      value.input.profiles[role] = profile.id;
    }
    value.batchApproval = null;
  });
  if (action === "run") return sprintRunner.start(id, revision);
  if (action === "pause") return sprintRunner.pause(id, revision);
  if (action === "resume") return sprintRunner.resume(id, revision);
  if (action === "plan" || action === "tickets") return updateSprint(id, revision, (value) => {
    if (value.status !== "draft") throw new Error("Planning requires a draft sprint");
    if (Object.values(value.state).some((state) => ["implementing", "reviewing", "checking"].includes(state.status))) throw new Error("A sprint job is already active");
    const key = action === "plan" ? "@plan" : "@tickets";
    if (!(action === "plan" ? value.input.profiles.planner : value.input.profiles.tickets)) throw new Error("Choose the planning/ticket agent first");
    if (!value.input.includedOnly) throw new Error("Confirm included subscription capacity only");
    if (action === "tickets" && !value.specApproval) throw new Error("Approve the specification before generating tickets");
    const old = value.state[key]; value.state[key] = { ...initialTicketState(), attempts: (old?.attempts ?? 0) + 1, repairs: old?.repairs ?? 0, status: "implementing", startedAt: Date.now() };
    value.batchApproval = null; value.error = null;
  });
  throw new Error("Unsupported sprint action");
}

/** Called only by the core that owns the API port, after native orphan reconciliation. */
export async function initSprints(notify?: (notice: TaskNotification) => void): Promise<void> {
  if (notify) postNotice = notify;
  if (timer) return;
  await recoverSprintCommands();
  const tick = () => {
    for (const sprint of listSprints()) {
      armDeadlines(sprint);
      if (sprint.error && sprint.status !== "paused" && sprint.status !== "completed") host.notify(sprint, sprint.error);
      void tickDraft(sprint).catch((error) => console.error("Sprint planning failed", error));
      void sprintRunner.tick(sprint.id).catch((error) => console.error("Sprint recovery needs attention", error));
    }
  };
  timer = setInterval(tick, 3000); timer.unref(); tick();
}
