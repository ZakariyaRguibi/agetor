import { agentProfiles, harnesses, runs, tasks, bindSprintTask } from "./db.ts";
import { activeRunCount, cancelLiveRunOfTask, createTask, isTaskRunLive, startTask } from "./orchestrator.ts";
import { prepareWorkdir } from "./worktree.ts";
import { harnessEnv, resolveBin } from "./agents.ts";
import { sprintCommand, sprintGit, stopSprintCommands } from "./sprint-command.ts";
import { getSprint, sprintBatchHash, updateSprint } from "./sprint-store.ts";
import { parseSprintResult } from "../shared/sprint-result.ts";
import { sprintTicketMarkdown, type Sprint, type SprintTicket } from "../shared/sprint.ts";
import type { Task } from "../shared/types.ts";
import type { SprintHost } from "./sprint-runner.ts";
import path from "node:path";
import { writeTaskDirFileAtomic, readTaskDirFile } from "./task-dir-fs.ts";
import { checkSprintShippingPolicy } from "./sprint-shipping-policy.ts";

function patch(id: string, mutate: (sprint: Sprint) => void): Sprint { return updateSprint(id, getSprint(id).revision, mutate); }
function marker(sprint: Sprint, key: string) { return `[sprint:${sprint.id}:${key}]`; }
const launching = new Map<string, string>();
function taskCwd(task: Task): string { return path.resolve(task.worktreePath || task.workdir); }
export function assertSprintWorkspaceIdle(cwd: string, ownTaskId?: string): void {
  const workspace = path.resolve(cwd);
  if (tasks.list().some((task) => task.id !== ownTaskId && taskCwd(task) === workspace && isTaskRunLive(task.id)) || [...launching].some(([id, dir]) => id !== ownTaskId && dir === workspace)) throw new Error("Agent capacity unavailable; previous workspace worker is still stopping");
}
function originalTask(sprint: Sprint, key: string): Task {
  const task = tasks.list().find((item) => item.title.startsWith(`${marker(sprint, key)} root `));
  if (!task?.worktreePath) throw new Error(`Missing isolated worktree for ${key}`);
  return task;
}
export function integrationTask(sprint: Sprint): Task {
  const task = sprint.integrationTaskId ? tasks.get(sprint.integrationTaskId) : null;
  if (!task?.worktreePath) throw new Error("Missing sprint integration worktree");
  return task;
}
export async function assertSprintClean(id: string, cwd: string): Promise<void> {
  if (await sprintGit(id, cwd, ["status", "--porcelain"])) throw new Error("Working tree contains uncommitted changes; preserve and resolve them before continuing");
}

/** Verify the selected harness's own login/configuration, never switch billing.
 * Account-side overage disabling remains the user's explicit attestation. */
export async function assertSprintBilling(sprint: Sprint, profileId: string, role: string): Promise<void> {
  if (!sprint.input.includedOnly) throw new Error("Included-capacity confirmation required");
  const profile = agentProfiles.get(profileId), harness = profile ? harnesses.get(profile.harness) : null;
  if (!profile || !harness) throw new Error(`Missing ${role} agent`);
  if (profile.speed !== "off" || profile.maxMode) throw new Error("Sprint profiles must disable speed/Max spending options");
  const environment = { ...process.env, ...harnessEnv(harness) };
  for (const key of Object.keys(environment)) if (/^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_API_BASE|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/.test(key) && environment[key]) throw new Error(`Unknown included billing route: ${key} is configured`);
  if (harness.kind === "opencode") {
    if (!profile.model.startsWith("opencode-go/deepseek")) throw new Error("Routine implementation must use the OpenCode Go DeepSeek provider");
    return;
  }
  if (harness.kind === "codex") {
    if (!/^gpt-6\.1-(sol|terra)$/.test(profile.model)) throw new Error("Sprint Codex roles require the approved Sol/Terra models");
    if (role === "review" && profile.mode !== "ask") throw new Error("Codex reviewer profile must use Read-only mode");
    const result = await sprintCommand(sprint.id, sprint.input.workdir, [resolveBin(harness), "login", "status"], 15_000, harnessEnv(harness));
    if (result.exitCode !== 0 || !/ChatGPT/i.test(result.output)) throw new Error("Codex ChatGPT login required; API-key billing is not allowed");
    return;
  }
  if (harness.kind === "claude-code") {
    if (!/sonnet/i.test(profile.model)) throw new Error("Claude sprint roles require Sonnet");
    const result = await sprintCommand(sprint.id, sprint.input.workdir, [resolveBin(harness), "auth", "status", "--json"], 15_000, harnessEnv(harness));
    if (result.exitCode !== 0 || !/claude\.ai/.test(result.output) || !/"loggedIn"\s*:\s*true/.test(result.output)) throw new Error("Claude subscription login required");
    return;
  }
  throw new Error(`Unsupported subscription route for ${harness.kind}`);
}

export async function startSprintTask(sprint: Sprint, task: Task, profileId: string, role: string, mayStart: (current: Sprint) => boolean = (current) => current.status === "running" && !!current.batchApproval): Promise<string> {
  if (isTaskRunLive(task.id)) return task.id;
  const latest = runs.listForTask(task.id)[0];
  // Reconciliation observes an already finished execution rather than duplicating it.
  if (latest && latest.status !== "orphaned") return task.id;
  const authorize = () => {
    const current = getSprint(sprint.id);
    if (current.status === "paused") throw new Error("Sprint paused");
    if (!mayStart(current) || (current.batchApproval && current.batchApproval !== sprintBatchHash(current.input))) throw new Error("Approval changed before model launch");
    return current;
  };
  const current = authorize();
  if (launching.has(task.id) || activeRunCount() + launching.size >= 3) throw new Error("Agent capacity unavailable; retry later");
  assertSprintWorkspaceIdle(taskCwd(task), task.id);
  launching.set(task.id, taskCwd(task));
  try {
  await assertSprintBilling(current, profileId, role);
  authorize();
  if (activeRunCount() >= 3) throw new Error("Agent capacity unavailable; retry later");
  assertSprintWorkspaceIdle(taskCwd(task), task.id);
  const result = await startTask(task.id, "sprint");
  if ("error" in result) throw new Error(result.error);
  return task.id;
  } finally { launching.delete(task.id); }
}

export async function nativeSprintPoll(taskId: string): ReturnType<SprintHost["poll"]> {
  const task = tasks.get(taskId);
  if (!task) return { status: "failed", output: "Native task was deleted" };
  if (isTaskRunLive(taskId)) return { status: "running", output: "" };
  const run = task.runId ? runs.get(task.runId) : runs.listForTask(taskId)[0];
  if (!run) return { status: "failed", output: "Native task never started" };
  const events = runs.eventsForTask(taskId, { limit: 200, maxBytes: 512_000 }).filter((event) => event.runId === run.id && event.subagentId == null);
  const output = events.map((event) => event.data).join("\n").slice(-128_000);
  if (run.status !== "succeeded" || run.exitCode !== 0) return { status: "failed", output: output || run.status };
  let result: Record<string, unknown> | undefined;
  try { result = parseSprintResult(events.filter((event) => event.stream === "assistant").map((event) => event.data)); } catch { /* caller requires explicit result for review/generation */ }
  return { status: "success", output, result };
}

export async function assertSprintPacket(sprint: Sprint, cwd: string): Promise<void> {
  for (const [name, expected] of [["spec.md", sprint.input.specification], ["tickets.md", sprintTicketMarkdown(sprint.input)]]) {
    const packet = await readTaskDirFile(path.join(cwd, "docs", "sprints", sprint.id, name!), 2_000_000);
    if (packet.kind !== "ok" || packet.text !== expected) throw new Error(`SPRINT_BLOCKER: approved ${name} changed in the worktree; approve a requirements revision before continuing`);
  }
}

export async function verifySprintWorktree(sprint: Sprint, cwd: string, key: string): Promise<string> {
  assertSprintWorkspaceIdle(cwd);
  await assertSprintPacket(sprint, cwd);
  await sprintGit(sprint.id, cwd, ["add", "--all"]);
  const before = await sprintGit(sprint.id, cwd, ["write-tree"]);
  patch(sprint.id, (value) => { value.state[key]!.checks = []; });
  const deadline = Date.now() + 20 * 60_000;
  for (const check of sprint.input.checks) {
    if (getSprint(sprint.id).status === "paused") throw new Error("Sprint paused");
    if (Date.now() >= deadline) throw new Error("Verification attempt timeout");
    const result = await sprintCommand(sprint.id, cwd, check.argv, deadline - Date.now());
    patch(sprint.id, (value) => { value.state[key]!.checks.push({ name: check.name, argv: check.argv, exitCode: result.exitCode, startedAt: result.startedAt, endedAt: result.endedAt, output: result.output.slice(-6000) }); });
    if (result.exitCode !== 0) throw new Error(`${check.name} failed (${result.exitCode}): ${result.output.slice(-6000)}`);
  }
  await sprintGit(sprint.id, cwd, ["add", "--all"]);
  if (before !== await sprintGit(sprint.id, cwd, ["write-tree"])) throw new Error("Checks changed source files; verify the revised candidate explicitly");
  const changed = await sprintCommand(sprint.id, cwd, ["git", "diff", "--cached", "--quiet"]);
  if (changed.exitCode === 1) await sprintGit(sprint.id, cwd, ["commit", "-m", `Implement approved sprint ${sprint.input.name}`]);
  else if (changed.exitCode !== 0) throw new Error("Could not inspect staged changes");
  await assertSprintClean(sprint.id, cwd);
  return sprintGit(sprint.id, cwd, ["rev-parse", "HEAD"]);
}

export function nativeSprintHost(finish: SprintHost["finish"]): SprintHost {
  return {
    capacity: () => Math.max(0, 3 - activeRunCount()),
    async prepare(sprint) {
      await assertSprintClean(sprint.id, sprint.input.workdir);
      await checkSprintShippingPolicy(sprint);
      const p = sprint.input.profiles;
      await assertSprintBilling(sprint, p.implementer, "implement");
      await assertSprintBilling(sprint, p.reviewer, "review");
      let task = sprint.integrationTaskId ? tasks.get(sprint.integrationTaskId) : tasks.list().find((item) => item.title === `${marker(sprint, "integration")} root`);
      if (!task) {
        const result = await createTask({ title: `${marker(sprint, "integration")} root`, prompt: "Sprint integration worktree. Do not run manually.", agentProfileId: p.implementer, workdir: sprint.input.workdir, isolation: "worktree", baseRef: sprint.input.shipping.base, branch: `codex/sprint-${sprint.id}` });
        if ("error" in result) throw new Error(result.error); task = result.task;
      }
      const prepared = await prepareWorkdir(task);
      if ("error" in prepared) throw new Error(prepared.error);
      tasks.update(task.id, { branch: prepared.branch, worktreePath: prepared.worktreePath });
      bindSprintTask(task.id, sprint.id, "integration");
      patch(sprint.id, (value) => { value.integrationTaskId = task!.id; value.branch = prepared.branch; });
      const packet = path.join("docs", "sprints", sprint.id);
      await writeTaskDirFileAtomic(path.join(prepared.cwd, packet, "spec.md"), sprint.input.specification, { mkdirParent: true });
      await writeTaskDirFileAtomic(path.join(prepared.cwd, packet, "tickets.md"), sprintTicketMarkdown(sprint.input), { mkdirParent: true });
      await sprintGit(sprint.id, prepared.cwd, ["add", "--", packet]);
      const changed = await sprintCommand(sprint.id, prepared.cwd, ["git", "diff", "--cached", "--quiet"]);
      if (changed.exitCode === 1) await sprintGit(sprint.id, prepared.cwd, ["commit", "-m", `Approve sprint ${sprint.id} specification and ticket batch`]);
      else if (changed.exitCode !== 0) throw new Error("Could not freeze approved sprint packet");
    },
    async launch(sprint, ticket, role, candidate) {
      const state = sprint.state[ticket.key]!, p = sprint.input.profiles;
      const profileId = role === "review" ? state.reviewFallback && p.planner ? p.planner : p.reviewer : state.repairs > 0 && p.escalation ? p.escalation : p.implementer;
      const title = `${marker(sprint, ticket.key)} ${role}:${state.attempts}:${state.repairs}`;
      let task = tasks.list().find((item) => item.title === title);
      if (!task) {
        let root = tasks.list().find((item) => item.title.startsWith(`${marker(sprint, ticket.key)} root `));
        if (!root) {
          const integration = integrationTask(getSprint(sprint.id));
          const base = await sprintGit(sprint.id, integration.worktreePath!, ["rev-parse", "HEAD"]);
          const result = await createTask({ title: `${marker(sprint, ticket.key)} root ${ticket.title}`, prompt: "Ticket worktree; executions appear as separate native tasks.", agentProfileId: p.implementer, workdir: sprint.input.workdir, isolation: "worktree", baseRef: base, branch: `codex/sprint-${sprint.id.slice(0, 8)}-${ticket.key}` });
          if ("error" in result) throw new Error(result.error);
          const prepared = await prepareWorkdir(result.task);
          if ("error" in prepared) throw new Error(prepared.error);
          root = tasks.update(result.task.id, { branch: prepared.branch, worktreePath: prepared.worktreePath })!;
          bindSprintTask(root.id, sprint.id, `root:${ticket.key}`);
        }
        if (role === "implement") {
          assertSprintWorkspaceIdle(root.worktreePath!);
          for (const dependency of ticket.dependencies) {
            const prerequisite = getSprint(sprint.id).state[dependency];
            if (prerequisite?.status !== "passed" || !prerequisite.candidate || prerequisite.reviewed !== prerequisite.candidate) throw new Error(`SPRINT_BLOCKER: prerequisite ${dependency} is not reviewed`);
            const inherited = await sprintCommand(sprint.id, root.worktreePath!, ["git", "merge-base", "--is-ancestor", prerequisite.candidate, "HEAD"]);
            if (inherited.exitCode !== 0) {
              if (await sprintGit(sprint.id, root.worktreePath!, ["status", "--porcelain"])) throw new Error(`SPRINT_BLOCKER: ${ticket.key} has uncommitted work and needs revised prerequisite ${dependency}; reconcile without discarding it`);
              try { await sprintGit(sprint.id, root.worktreePath!, ["merge", "--no-edit", prerequisite.candidate]); }
              catch (error) { throw new Error(`SPRINT_BLOCKER: prerequisite integration conflict: ${String(error)}`); }
            }
          }
        }
        const prompt = role === "implement"
          ? `${sprint.input.specification}\n\nTicket ${ticket.key}: ${ticket.title}\n${ticket.prompt}\nAcceptance:\n${ticket.acceptance.join("\n")}\nPrevious failure:\n${state.error ?? "none"}\nImplement only this ticket. Add tests and relevant documentation. Do not commit, push, merge, write/change credentials, buy credits or delegate to other agents. If scope or architecture must change, stop and return <sprint-result>{"requiresApproval":true,"reason":"decision needed"}</sprint-result>.`
          : `Independently review candidate ${candidate} for ticket ${ticket.key}. Compare git diff ${root.baseRef} ${candidate}.\nSpecification:\n${sprint.input.specification}\nTicket:\n${JSON.stringify(ticket)}\nVerification evidence:\n${JSON.stringify(state.checks)}\nInspect the actual diff and acceptance criteria; do not edit files or delegate. Return exactly one <sprint-result>{"verdict":"PASS" or "REQUEST_CHANGES","candidate":"${candidate}","findings":[]}</sprint-result>. PASS requires no unresolved findings. Do not publish changes.`;
        const result = await createTask({ title, prompt, agentProfileId: profileId, workdir: root.worktreePath!, isolation: "none" });
        if ("error" in result) throw new Error(result.error); task = result.task;
      }
      bindSprintTask(task.id, sprint.id, `${role}:${ticket.key}`);
      return startSprintTask(sprint, task, profileId, role);
    },
    poll: nativeSprintPoll,
    async verify(sprint, key) { return verifySprintWorktree(sprint, originalTask(sprint, key).worktreePath!, key); },
    async integrate(sprint, key) {
      const state = sprint.state[key]!, root = originalTask(sprint, key);
      assertSprintWorkspaceIdle(root.worktreePath!);
      await assertSprintClean(sprint.id, root.worktreePath!);
      if (await sprintGit(sprint.id, root.worktreePath!, ["rev-parse", "HEAD"]) !== state.candidate) throw new Error("Reviewed candidate changed");
      const integration = integrationTask(getSprint(sprint.id));
      assertSprintWorkspaceIdle(integration.worktreePath!);
      await assertSprintClean(sprint.id, integration.worktreePath!);
      try { await sprintGit(sprint.id, integration.worktreePath!, ["merge", "--no-edit", state.candidate!]); }
      catch (error) { throw new Error(`SPRINT_BLOCKER: integration conflict requires human resolution. ${error instanceof Error ? error.message : String(error)}`); }
    },
    finish,
    async cancel(sprint) { stopSprintCommands(sprint.id); await Promise.all(Object.values(sprint.state).flatMap((state) => [state.taskId, state.reviewTaskId]).filter((id): id is string => !!id).map((id) => cancelLiveRunOfTask(id))); },
    async stop(id) { await cancelLiveRunOfTask(id); },
    notify(_sprint, _message) { /* wired to native notifications with the sprint controls */ },
  };
}
