import { createHash } from "node:crypto";
import path from "node:path";
import { initialTicketState, sprintCanShip, selectedSprintTickets, type Sprint } from "../shared/sprint.ts";
import { requireSprintReview } from "../shared/sprint-result.ts";
import { getSprint, updateSprint, sprintBatchHash } from "./sprint-store.ts";
import { integrationTask, assertSprintClean, assertSprintPacket, verifySprintWorktree } from "./sprint-native.ts";
import { sprintCommand as defaultCommand, sprintGit as defaultGit } from "./sprint-command.ts";
import { sprintJob } from "./sprint-job.ts";
import { readTaskDirFile } from "./task-dir-fs.ts";
import { cancelLiveRunOfTask, isTaskRunLive } from "./orchestrator.ts";
import { requireSprintShippingPolicy } from "./sprint-shipping-policy.ts";

function patch(id: string, mutate: (sprint: Sprint) => void) { return updateSprint(id, getSprint(id).revision, mutate); }
function authorized(id: string) {
  const sprint = getSprint(id);
  if (!["verifying", "shipping"].includes(sprint.status) || !sprintCanShip(sprint) || sprint.batchApproval !== sprintBatchHash(sprint.input)) throw new Error("Sprint release authorization changed");
  return sprint;
}
async function defaultGithub(sprint: Sprint, args: string[]): Promise<string> {
  const command = [...args];
  const repoIndex = command.indexOf("--repo");
  if (repoIndex >= 0 && command[repoIndex + 1]) command[repoIndex + 1] = `https://github.com/${command[repoIndex + 1]}`;
  if (command[0] === "api") command.push("--hostname", "github.com");
  const result = await defaultCommand(sprint.id, sprint.input.workdir, ["gh", ...command], 120_000);
  if (result.exitCode !== 0 || result.truncated) throw new Error(`GitHub command failed: ${result.output.slice(-4000)}`);
  return result.output.trim();
}
interface SprintPr { number: number; url: string; state: string; headRefOid: string; mergeCommit: { oid: string } | null; statusCheckRollup?: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }> }
export function sprintCiPassed(checks: SprintPr["statusCheckRollup"], required: string[]): boolean {
  return required.length > 0 && required.every((name) => {
    const matches = (checks ?? []).filter((check) => (check.name ?? check.context) === name);
    return matches.length > 0 && matches.every((check) => check.conclusion === "SUCCESS" && check.status === "COMPLETED" || check.state === "SUCCESS");
  });
}

/** Called incrementally by the native runner; a PR is addressed by one stable branch. */
export async function finishSprint(initial: Sprint, effects: { git?: typeof defaultGit; command?: typeof defaultCommand; github?: typeof defaultGithub } = {}): Promise<"pending" | "completed"> {
  const sprintGit = effects.git ?? defaultGit, sprintCommand = effects.command ?? defaultCommand, github = effects.github ?? defaultGithub;
  let sprint = authorized(initial.id);
  if (sprint.releasePollAt && sprint.releasePollAt > Date.now()) return "pending";
  const cwd = integrationTask(sprint).worktreePath!, repo = sprint.input.shipping.repository;
  if (!sprint.branch) throw new Error("Missing sprint branch");
  const branch = sprint.branch;
  const repair = (message: string): "pending" => {
    const current = getSprint(sprint.id), state = current.state["@final"];
    if (!state || state.repairs >= 3) throw new Error(`Final verification repair budget exhausted: ${message}`);
    patch(sprint.id, (value) => { const next = value.state["@final"]!; next.repairs += 1; next.error = message; next.candidate = null; next.reviewed = null; next.status = "queued"; value.status = "verifying"; });
    return "pending";
  };
  if (sprint.input.shipping.enabled) {
    const origin = await sprintGit(sprint.id, sprint.input.workdir, ["remote", "get-url", "origin"]);
    const match = origin.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match?.[1]?.toLowerCase() !== repo.toLowerCase()) throw new Error("Shipping repository does not match Git origin");
    const prs = JSON.parse(await github(sprint, ["pr", "list", "--repo", repo, "--state", "all", "--head", sprint.branch, "--base", sprint.input.shipping.base, "--json", "number,url,state,headRefOid,mergeCommit"])) as SprintPr[];
    if (prs.length > 1) throw new Error("Multiple sprint PRs require human reconciliation");
    const merged = prs[0]?.state === "MERGED" ? prs[0] : null;
    if (merged) {
      if (!merged.mergeCommit?.oid) throw new Error("Merged PR has no merge SHA");
      await sprintGit(sprint.id, sprint.input.workdir, ["fetch", "origin", sprint.input.shipping.base]);
      await sprintGit(sprint.id, sprint.input.workdir, ["merge-base", "--is-ancestor", merged.mergeCommit.oid, `origin/${sprint.input.shipping.base}`]);
      patch(sprint.id, (value) => { value.prUrl = merged.url; value.mergeSha = merged.mergeCommit!.oid; });
      await assertSprintClean(sprint.id, sprint.input.workdir);
      await sprintGit(sprint.id, sprint.input.workdir, ["switch", sprint.input.shipping.base]);
      await sprintGit(sprint.id, sprint.input.workdir, ["merge", "--ff-only", `origin/${sprint.input.shipping.base}`]);
      return "completed";
    }
    if (prs[0]?.state === "CLOSED") throw new Error("Sprint PR was closed without merging");
  }
  sprint = getSprint(sprint.id);
  const docs = sprint.state["@docs"];
  if (docs?.status !== "passed") {
    const before = docs?.candidate ?? await sprintGit(sprint.id, cwd, ["rev-parse", "HEAD"]);
    if (!docs) patch(sprint.id, (value) => { value.state["@docs"] = { ...initialTicketState(), candidate: before, status: "implementing", attempts: 1, startedAt: Date.now() }; });
    const result = await sprintJob(getSprint(sprint.id), "@docs", sprint.input.profiles.implementer, cwd, `Update setup instructions/README, relevant architecture decisions and CHANGELOG.md for this completed sprint. Write docs/sprints/${sprint.id}/report.md explaining delivered tickets, tests, limitations and how to run the project. Only edit Markdown documentation. Do not edit code/config/tests, commit, push, merge, change credentials or delegate.\nSpecification:\n${sprint.input.specification}\nCompleted tickets:\n${JSON.stringify(selectedSprintTickets(sprint.input))}`, "implement");
    if (!result) return "pending";
    const changed = await sprintGit(sprint.id, cwd, ["diff", "--name-only", before]);
    const untracked = await sprintGit(sprint.id, cwd, ["ls-files", "--others", "--exclude-standard"]);
    if (`${changed}\n${untracked}`.split("\n").filter(Boolean).some((file) => !file.endsWith(".md"))) throw new Error("Documentation job changed non-document source; review the scope revision");
    for (const file of ["README.md", "CHANGELOG.md", `docs/sprints/${sprint.id}/report.md`]) {
      const content = await readTaskDirFile(path.join(cwd, file), 1_000_000);
      if (content.kind !== "ok" || !content.text.trim()) {
        const current = getSprint(sprint.id), state = current.state["@docs"]!;
        if (state.repairs >= 3) throw new Error(`Documentation repair budget exhausted: ${file} is missing or empty`);
        patch(sprint.id, (value) => { const next = value.state["@docs"]!; next.repairs += 1; next.attempts += 1; next.taskId = null; next.startedAt = null; next.error = `${file} is missing or empty`; });
        return "pending";
      }
    }
    await assertSprintPacket(sprint, cwd);
    patch(sprint.id, (value) => { value.state["@docs"]!.status = "passed"; });
  }
  sprint = getSprint(sprint.id);
  let final = sprint.state["@final"];
  if (!final) { sprint = patch(sprint.id, (value) => { value.state["@final"] = initialTicketState(); }); final = sprint.state["@final"]!; }
  if (!final.candidate) {
    if (final.error && final.repairs > 0) {
      const fixed = await sprintJob(sprint, `@final-repair-${final.repairs}`, sprint.input.profiles.escalation || sprint.input.profiles.implementer, cwd, `Repair the whole-sprint verification/review failure within the approved specification. Preserve unrelated work and update tests/documentation as needed. Do not publish, change requirements or delegate. Stop for architecture/scope decisions.\nFailure:\n${final.error}\nSpecification:\n${sprint.input.specification}`, "implement");
      if (!fixed) return "pending";
      patch(sprint.id, (value) => { value.state["@final"]!.error = null; });
    }
    const paths = await sprintGit(sprint.id, cwd, ["diff", "--name-only", sprint.input.shipping.base]);
    if (/\.(tsx|jsx|html|css|vue|svelte)$/m.test(paths) && !sprint.input.checks.some((check) => /browser|playwright|cypress|e2e/i.test(`${check.name} ${check.argv.join(" ")}`))) throw new Error("UI changes require an approved browser check");
    let candidate: string;
    try { candidate = await verifySprintWorktree(sprint, cwd, "@final"); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (getSprint(sprint.id).status === "paused" || message.startsWith("SPRINT_BLOCKER:")) throw error;
      if (message.startsWith("Agent capacity unavailable")) return "pending";
      return repair(message);
    }
    patch(sprint.id, (value) => { value.state["@final"]!.candidate = candidate; });
    return "pending";
  }
  if (sprint.input.shipping.enabled) {
    await sprintGit(sprint.id, cwd, ["fetch", "origin", sprint.input.shipping.base]);
    const base = await sprintGit(sprint.id, cwd, ["rev-parse", `origin/${sprint.input.shipping.base}`]);
    const included = await sprintCommand(sprint.id, cwd, ["git", "merge-base", "--is-ancestor", base, "HEAD"]);
    if (included.exitCode !== 0) {
      const readers = Object.entries(getSprint(sprint.id).state).filter(([key, state]) => key.startsWith("@final-review") && state.taskId && isTaskRunLive(state.taskId)).map(([, state]) => state.taskId!);
      await Promise.all(readers.map((id) => cancelLiveRunOfTask(id)));
      if (readers.some((id) => isTaskRunLive(id))) return "pending";
      await assertSprintClean(sprint.id, cwd);
      await sprintGit(sprint.id, cwd, ["merge", "--no-edit", base]);
      patch(sprint.id, (value) => { const old = value.state["@final"]; value.state["@final"] = { ...initialTicketState(), repairs: old?.repairs ?? 0, attempts: (old?.attempts ?? 0) + 1 }; for (const [key, state] of Object.entries(value.state)) if (key.startsWith("@final-review")) state.status = "failed"; value.status = "verifying"; });
      return "pending";
    }
  }
  if (final.reviewed !== final.candidate) {
    const reviewKey = `@final-review-${createHash("sha256").update(final.candidate).digest("hex").slice(0, 16)}-${final.repairs}`;
    const result = await sprintJob(sprint, reviewKey, sprint.input.profiles.reviewer, cwd, `Independently review the whole sprint candidate ${final.candidate}. Compare git diff ${sprint.input.shipping.base} ${final.candidate}. Inspect code, documentation, acceptance criteria and verification evidence for the selected tickets only; other backlog items are outside this sprint. Do not edit files, publish or delegate. Return exactly one <sprint-result>{"verdict":"PASS" or "REQUEST_CHANGES","candidate":"${final.candidate}","findings":[]}</sprint-result>. Missing evidence or unresolved findings require REQUEST_CHANGES.\nSpecification:\n${sprint.input.specification}\nTickets:\n${JSON.stringify(selectedSprintTickets(sprint.input))}\nChecks:\n${JSON.stringify(final.checks)}`, "review");
    if (!result) return "pending";
    try { requireSprintReview(result.result ?? {}, final.candidate); }
    catch (error) { return repair(error instanceof Error ? error.message : String(error)); }
    await assertSprintClean(sprint.id, cwd);
    if (await sprintGit(sprint.id, cwd, ["rev-parse", "HEAD"]) !== final.candidate) throw new Error("Final reviewed candidate changed");
    patch(sprint.id, (value) => { value.state["@final"]!.reviewed = final!.candidate; value.state["@final"]!.status = "passed"; value.status = "shipping"; });
    return "pending";
  }
  if (!sprint.input.shipping.enabled) return "completed";
  // A head lease alone cannot close a concurrent base-update race. Require
  // server-side up-to-date checks that apply to administrators as well.
  const protection = JSON.parse(await github(sprint, ["api", `repos/${repo}/branches/${encodeURIComponent(sprint.input.shipping.base)}/protection`])) as { required_status_checks?: { strict?: boolean }; enforce_admins?: { enabled?: boolean } };
  requireSprintShippingPolicy(protection);
  authorized(sprint.id);
  await assertSprintClean(sprint.id, cwd);
  const head = await sprintGit(sprint.id, cwd, ["rev-parse", "HEAD"]);
  if (head !== final.reviewed) throw new Error("Final revision no longer matches review");
  const push = await sprintCommand(sprint.id, cwd, ["git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `${head}:refs/heads/${sprint.branch}`], 120_000);
  if (push.exitCode !== 0) throw new Error(`Push failed: ${push.output.slice(-4000)}`);
  const listArgs = ["pr", "list", "--repo", repo, "--state", "all", "--head", branch, "--base", sprint.input.shipping.base, "--json", "number,url,state,headRefOid,mergeCommit"];
  let prs = JSON.parse(await github(sprint, listArgs)) as SprintPr[];
  if (prs.length === 0) {
    authorized(sprint.id);
    await github(sprint, ["pr", "create", "--repo", repo, "--base", sprint.input.shipping.base, "--head", branch, "--title", sprint.input.name, "--body", `Approved sprint ${sprint.id}. Tickets: ${sprint.input.selected.join(", ")}. Documentation and verification report: docs/sprints/${sprint.id}/report.md. Independent review approved candidate ${head}.`]);
    prs = JSON.parse(await github(sprint, listArgs)) as SprintPr[];
  }
  if (prs.length !== 1 || prs[0]!.state !== "OPEN") throw new Error("Expected one open sprint PR");
  const pr = JSON.parse(await github(sprint, ["pr", "view", String(prs[0]!.number), "--repo", repo, "--json", "number,url,state,headRefOid,statusCheckRollup,mergeCommit"])) as SprintPr;
  patch(sprint.id, (value) => { value.prUrl = pr.url; });
  if (pr.headRefOid !== head) throw new Error("PR head does not match verified revision");
  if (!sprintCiPassed(pr.statusCheckRollup, sprint.input.shipping.requiredChecks)) {
    const failed = (pr.statusCheckRollup ?? []).filter((check) => sprint.input.shipping.requiredChecks.includes(check.name ?? check.context ?? "") && (check.conclusion === "FAILURE" || check.conclusion === "CANCELLED" || check.state === "FAILURE" || check.state === "ERROR"));
    if (failed.length) return repair(`Required CI failed: ${JSON.stringify(failed)}`);
    patch(sprint.id, (value) => { value.releasePollAt = Date.now() + 30_000; });
    return "pending";
  }
  authorized(sprint.id);
  await sprintGit(sprint.id, cwd, ["fetch", "origin", sprint.input.shipping.base]);
  await sprintGit(sprint.id, cwd, ["merge-base", "--is-ancestor", `origin/${sprint.input.shipping.base}`, head]);
  await github(sprint, ["pr", "merge", String(pr.number), "--repo", repo, "--squash", "--match-head-commit", head]);
  // The next pass confirms the remote merge and clean local fast-forward.
  return "pending";
}
