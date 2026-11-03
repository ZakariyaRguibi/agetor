import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-command-"));
const { createSprint, getSprint, updateSprint } = await import("./sprint-store.ts");
const { sprintFixture } = await import("../test-sprint-fixture.ts");
const { sprintCommand, recoverSprintCommands } = await import("./sprint-command.ts");
const { db } = await import("./db.ts");
function fixture() {
  const input = sprintFixture(); input.workdir = mkdtempSync(join(tmpdir(), "agetor-sprint-command-cwd-"));
  return createSprint(input);
}
test("verification commands are bounded, journal completion and refuse paused runs", async () => {
  let sprint = fixture();
  const result = await sprintCommand(sprint.id, sprint.input.workdir, [process.execPath, "-e", 'console.log("ok")']);
  expect(result.exitCode).toBe(0); expect(result.output).toContain("ok");
  const timeout = await sprintCommand(sprint.id, sprint.input.workdir, [process.execPath, "-e", "setInterval(() => {}, 1000)"], 100);
  expect(timeout.exitCode).not.toBe(0);
  expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM sprint_commands WHERE sprint_id = ? AND completed = 0").get(sprint.id)!.n).toBe(0);
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.status = "paused"; });
  await expect(sprintCommand(sprint.id, sprint.input.workdir, [process.execPath, "-e", "process.exit(0)"])).rejects.toThrow("paused");
});
test("recovery terminates an identified orphan group and preserves repair counters", async () => {
  let sprint = fixture();
  sprint = updateSprint(sprint.id, sprint.revision, (value) => { value.state["LA-01"]!.repairs = 2; });
  const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const birth = Bun.spawnSync(["/bin/ps", "-p", String(proc.pid), "-o", "lstart="], { stdout: "pipe" }).stdout.toString().trim();
  expect(birth).not.toBe("");
  db.run("INSERT INTO sprint_commands (id, sprint_id, pid, birth) VALUES (?, ?, ?, ?)", [`orphan-${sprint.id}`, sprint.id, proc.pid, birth]);
  await recoverSprintCommands(); await proc.exited;
  expect(getSprint(sprint.id).state["LA-01"]!.repairs).toBe(2);
});
test("an interrupted launch with unknown identity checkpoints without starting duplicate workers", async () => {
  const sprint = fixture();
  db.run("INSERT INTO sprint_commands (id, sprint_id) VALUES (?, ?)", [`unknown-${sprint.id}`, sprint.id]);
  await recoverSprintCommands();
  expect(getSprint(sprint.id).status).toBe("needs_attention");
  expect(getSprint(sprint.id).error).toContain("no duplicate");
});
