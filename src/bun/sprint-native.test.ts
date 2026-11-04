import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-native-"));
const { createSprint, getSprint, updateSprint } = await import("./sprint-store.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
const { createTask } = await import("./orchestrator.ts");
const { prepareWorkdir } = await import("./worktree.ts");
const { tasks } = await import("./db.ts");
const { nativeSprintHost } = await import("./sprint-native.ts");
const { sprintTicketMarkdown } = await import("../shared/sprint.ts");

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function worktree(id: string, repository: string, key: string, base: string) {
  const result = await createTask({ title: `[sprint:${id}:${key}] root ${key === "integration" ? "" : key}`.trim(), prompt: "Disposable qualification fixture", agent: "claude-code", workdir: repository, isolation: "worktree", baseRef: base, branch: `codex/sprint-${id.slice(0, 8)}-${key}` });
  if ("error" in result) throw new Error(result.error);
  const prepared = await prepareWorkdir(result.task);
  if ("error" in prepared) throw new Error(prepared.error);
  return tasks.update(result.task.id, { branch: prepared.branch, worktreePath: prepared.worktreePath })!;
}

test("reviewed prerequisite code is inherited by isolated parallel ticket worktrees; reassembly is idempotent", async () => {
  const repository = mkdtempSync(join(tmpdir(), "agetor-sprint-repository-"));
  git(repository, "init", "-b", "main"); git(repository, "config", "user.name", "Sprint Fixture"); git(repository, "config", "user.email", "sprint-fixture@example.invalid");
  writeFileSync(join(repository, "README.md"), "Fixture\n"); git(repository, "add", "README.md"); git(repository, "commit", "-m", "Fixture base");
  const input = sprintFixture(); input.workdir = repository;
  input.checks = [{ name: "Prerequisite smoke", argv: [process.execPath, "-e", 'if (require("node:fs").readFileSync("contracts.txt", "utf8") !== "prerequisite") process.exit(1)'] }];
  let sprint = createSprint(input);
  const integration = await worktree(sprint.id, repository, "integration", "main");
  const packet = join(integration.worktreePath!, "docs", "sprints", sprint.id); mkdirSync(packet, { recursive: true });
  writeFileSync(join(packet, "spec.md"), input.specification); writeFileSync(join(packet, "tickets.md"), sprintTicketMarkdown(input));
  git(integration.worktreePath!, "add", "docs"); git(integration.worktreePath!, "commit", "-m", "Approve fixture packet");
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.integrationTaskId = integration.id; value.branch = integration.branch; value.status = "running"; });
  const host = nativeSprintHost(async () => "pending");
  const root = await worktree(sprint.id, repository, "LA-01", git(integration.worktreePath!, "rev-parse", "HEAD"));
  writeFileSync(join(root.worktreePath!, "contracts.txt"), "prerequisite");
  const candidate = await host.verify(sprint, "LA-01");
  sprint = updateSprint(sprint.id, getSprint(sprint.id).revision, (value) => { value.state["LA-01"]!.candidate = candidate; });
  await host.integrate(sprint, "LA-01"); await host.integrate(sprint, "LA-01");
  expect(git(integration.worktreePath!, "rev-parse", "HEAD")).toBe(candidate);
  expect(getSprint(sprint.id).state["LA-01"]!.checks[0]!.exitCode).toBe(0);
  const [rng, save] = await Promise.all([worktree(sprint.id, repository, "LA-03", candidate), worktree(sprint.id, repository, "LA-08", candidate)]);
  expect(rng.worktreePath).not.toBe(save.worktreePath);
  expect(rng.branch).not.toBe(save.branch);
  for (const task of [rng, save]) expect(readFileSync(join(task.worktreePath!, "contracts.txt"), "utf8")).toBe("prerequisite");
  writeFileSync(join(rng.worktreePath!, "rng.txt"), "rng"); writeFileSync(join(save.worktreePath!, "save.txt"), "save");
  expect(git(rng.worktreePath!, "ls-files", "--others", "--exclude-standard")).toBe("rng.txt");
  expect(git(save.worktreePath!, "ls-files", "--others", "--exclude-standard")).toBe("save.txt");
  const [rngSha, saveSha] = await Promise.all([host.verify(getSprint(sprint.id), "LA-03"), host.verify(getSprint(sprint.id), "LA-08")]);
  sprint = updateSprint(sprint.id, getSprint(sprint.id).revision, (value) => { value.state["LA-03"]!.candidate = rngSha; value.state["LA-08"]!.candidate = saveSha; });
  await host.integrate(sprint, "LA-03"); await host.integrate(sprint, "LA-08");
  expect(readFileSync(join(integration.worktreePath!, "rng.txt"), "utf8")).toBe("rng");
  expect(readFileSync(join(integration.worktreePath!, "save.txt"), "utf8")).toBe("save");
  expect(git(repository, "log", "--format=%s", "main")).toBe("Fixture base");
  writeFileSync(join(packet, "spec.md"), "Unapproved scope change");
  await expect(host.verify(getSprint(sprint.id), "LA-03")).resolves.toBe(rngSha);
  // The integration workspace's frozen packet is independently protected.
  const { verifySprintWorktree } = await import("./sprint-native.ts");
  sprint = updateSprint(sprint.id, getSprint(sprint.id).revision, (value) => { value.state["@final"] = { ...value.state["LA-01"]! }; });
  await expect(verifySprintWorktree(sprint, integration.worktreePath!, "@final")).rejects.toThrow("SPRINT_BLOCKER: approved spec.md changed");
  writeFileSync(join(packet, "spec.md"), input.specification);
  writeFileSync(join(rng.worktreePath!, "conflict.txt"), "rng owns this");
  writeFileSync(join(save.worktreePath!, "conflict.txt"), "save owns this");
  const first = await host.verify(getSprint(sprint.id), "LA-03"), second = await host.verify(getSprint(sprint.id), "LA-08");
  sprint = updateSprint(sprint.id, getSprint(sprint.id).revision, (value) => { value.state["LA-03"]!.candidate = first; value.state["LA-08"]!.candidate = second; });
  await host.integrate(sprint, "LA-03");
  await expect(host.integrate(sprint, "LA-08")).rejects.toThrow("SPRINT_BLOCKER: integration conflict");
  expect(git(repository, "log", "--format=%s", "main")).toBe("Fixture base");
}, 20_000);
