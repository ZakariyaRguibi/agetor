import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-release-"));
const { sprintCiPassed, finishSprint } = await import("./sprint-release.ts");
const { createSprint, updateSprint, getSprint, sprintBatchHash, sprintSpecHash } = await import("./sprint-store.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
const { initialTicketState } = await import("../shared/sprint.ts");
const { createTask } = await import("./orchestrator.ts");
const { prepareWorkdir } = await import("./worktree.ts");
const { tasks } = await import("./db.ts");
const { sprintGit, sprintCommand } = await import("./sprint-command.ts");
test("release refuses absent, failed, skipped and unfinished required CI checks", () => {
  const green = { name: "checks", status: "COMPLETED", conclusion: "SUCCESS" };
  expect(sprintCiPassed([green], ["checks"])).toBe(true);
  expect(sprintCiPassed([green], [])).toBe(false);
  expect(sprintCiPassed([], ["checks"])).toBe(false);
  for (const conclusion of ["FAILURE", "SKIPPED", "CANCELLED", "NEUTRAL"]) expect(sprintCiPassed([{ ...green, conclusion }], ["checks"])).toBe(false);
  expect(sprintCiPassed([{ ...green, status: "IN_PROGRESS", conclusion: undefined }], ["checks"])).toBe(false);
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function releaseFixture(green = true, strict = true) {
  const repository = mkdtempSync(join(tmpdir(), "agetor-release-repo-"));
  git(repository, "init", "-b", "main"); git(repository, "config", "user.name", "Release Fixture"); git(repository, "config", "user.email", "release@example.invalid");
  writeFileSync(join(repository, "README.md"), "Fixture"); git(repository, "add", "README.md"); git(repository, "commit", "-m", "Base");
  const base = git(repository, "rev-parse", "HEAD"); git(repository, "remote", "add", "origin", "https://github.com/fixture/world.git"); git(repository, "update-ref", "refs/remotes/origin/main", base);
  const input = sprintFixture(); input.workdir = repository; input.selected = ["LA-01"]; input.shipping.repository = "fixture/world";
  let sprint = createSprint(input);
  const created = await createTask({ title: `Release ${sprint.id}`, prompt: "Disposable release fixture", agent: "claude-code", workdir: repository, isolation: "worktree", baseRef: "main", branch: `codex/release-${sprint.id}` });
  if ("error" in created) throw new Error(created.error);
  const prepared = await prepareWorkdir(created.task); if ("error" in prepared) throw new Error(prepared.error);
  tasks.update(created.task.id, { branch: prepared.branch, worktreePath: prepared.worktreePath });
  writeFileSync(join(prepared.cwd, "feature.txt"), "verified feature"); git(prepared.cwd, "add", "feature.txt"); git(prepared.cwd, "commit", "-m", "Feature");
  const candidate = git(prepared.cwd, "rev-parse", "HEAD");
  sprint = updateSprint(sprint.id, sprint.revision, (value) => {
    value.status = "shipping"; value.specApproval = sprintSpecHash(value.input); value.batchApproval = sprintBatchHash(value.input); value.integrationTaskId = created.task.id; value.branch = prepared.branch;
    for (const key of ["LA-01", "@docs", "@final"]) value.state[key] = { ...initialTicketState(), status: "passed", candidate, reviewed: candidate };
  });
  let pr: { number: number; url: string; state: string; headRefOid: string; mergeCommit: { oid: string } | null } | null = null;
  const counts = { pushes: 0, prs: 0, merges: 0 };
  const effects: Parameters<typeof finishSprint>[1] = {
    git: async (id, cwd, args) => args[0] === "fetch" ? "" : sprintGit(id, cwd, args),
    command: async (id, cwd, argv, timeout, env) => {
      if (argv[0] === "git" && argv.includes("push")) { counts.pushes += 1; return { argv, startedAt: 0, endedAt: 1, exitCode: 0, output: "", truncated: false }; }
      return sprintCommand(id, cwd, argv, timeout, env);
    },
    github: async (_sprint, args) => {
      if (args[0] === "api") return JSON.stringify({ required_status_checks: { strict }, enforce_admins: { enabled: strict } });
      if (args[1] === "list") return JSON.stringify(pr ? [pr] : []);
      if (args[1] === "create") { counts.prs += 1; pr = { number: 1, url: "https://github.com/fixture/world/pull/1", state: "OPEN", headRefOid: candidate, mergeCommit: null }; return pr.url; }
      if (args[1] === "view") return JSON.stringify({ ...pr, statusCheckRollup: green ? [{ name: "checks", status: "COMPLETED", conclusion: "SUCCESS" }] : [] });
      if (args[1] === "merge") {
        counts.merges += 1;
        const sha = git(repository, "commit-tree", `${candidate}^{tree}`, "-p", base, "-m", "Squash sprint");
        git(repository, "update-ref", "refs/remotes/origin/main", sha);
        pr!.state = "MERGED"; pr!.mergeCommit = { oid: sha }; return "";
      }
      throw new Error(`Unexpected mocked GitHub command: ${args.join(" ")}`);
    },
  };
  return { sprint, effects, counts, repository, candidate, prepared };
}

test("repeated release attempts create one PR and one merge, confirm remote ancestry and fast-forward local main", async () => {
  const fixture = await releaseFixture();
  expect(await finishSprint(fixture.sprint, fixture.effects)).toBe("pending");
  expect(await finishSprint(getSprint(fixture.sprint.id), fixture.effects)).toBe("completed");
  expect(await finishSprint(getSprint(fixture.sprint.id), fixture.effects)).toBe("completed");
  expect(fixture.counts).toEqual({ pushes: 1, prs: 1, merges: 1 });
  expect(readFileSync(join(fixture.repository, "feature.txt"), "utf8")).toBe("verified feature");
  expect(git(fixture.repository, "status", "--porcelain")).toBe("");
  expect(getSprint(fixture.sprint.id).mergeSha).toBe(git(fixture.repository, "rev-parse", "HEAD"));
});
test("missing required CI leaves the sprint PR open and main untouched", async () => {
  const fixture = await releaseFixture(false);
  const before = git(fixture.repository, "rev-parse", "main");
  expect(await finishSprint(fixture.sprint, fixture.effects)).toBe("pending");
  expect(fixture.counts.merges).toBe(0); expect(fixture.counts.prs).toBe(1);
  expect(git(fixture.repository, "rev-parse", "main")).toBe(before);
  await finishSprint(getSprint(fixture.sprint.id), fixture.effects);
  expect(fixture.counts).toEqual({ pushes: 1, prs: 1, merges: 0 });
});
test("base advancement invalidates the old final review before publishing", async () => {
  const fixture = await releaseFixture();
  writeFileSync(join(fixture.repository, "main-advance.txt"), "new upstream work"); git(fixture.repository, "add", "main-advance.txt"); git(fixture.repository, "commit", "-m", "Main advanced");
  git(fixture.repository, "update-ref", "refs/remotes/origin/main", git(fixture.repository, "rev-parse", "HEAD"));
  expect(await finishSprint(fixture.sprint, fixture.effects)).toBe("pending");
  expect(getSprint(fixture.sprint.id).state["@final"]!.candidate).toBeNull();
  expect(fixture.counts).toEqual({ pushes: 0, prs: 0, merges: 0 });
});
test("shipping refuses a base policy that permits stale-base merges", async () => {
  const fixture = await releaseFixture(true, false);
  await expect(finishSprint(fixture.sprint, fixture.effects)).rejects.toThrow("strict up-to-date");
  expect(fixture.counts).toEqual({ pushes: 0, prs: 0, merges: 0 });
});
