import { childEnv, coreSpawn } from "./core-spawn.ts";
import { SPRINT_LIMITS } from "../shared/sprint.ts";
import { getSprint } from "./sprint-store.ts";
import { updateSprint } from "./sprint-store.ts";
import { db } from "./db.ts";
import { randomUUID } from "node:crypto";

export interface SprintCommandResult { argv: string[]; startedAt: number; endedAt: number; exitCode: number; output: string; truncated: boolean }
const processes = new Map<string, Set<Bun.Subprocess>>();

async function birthOf(pid: number): Promise<string | null> {
  const proc = coreSpawn(["/bin/ps", "-p", String(pid), "-o", "lstart="], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore" }) as Bun.Subprocess<"ignore", "pipe", "ignore">;
  const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 && output.trim() ? output.trim() : null;
}
function possiblyAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Reconcile only leases belonging to a previous core. A PID is never killed
 * unless its recorded kernel start time still matches (PID reuse is safe). */
export async function recoverSprintCommands(): Promise<void> {
  const rows = db.query<{ id: string; sprint_id: string; pid: number | null; birth: string | null }, []>("SELECT id, sprint_id, pid, birth FROM sprint_commands WHERE completed = 0").all();
  for (const row of rows) {
    if (row.pid === null) {
      const sprint = getSprint(row.sprint_id);
      if (sprint.status !== "paused") updateSprint(sprint.id, sprint.revision, (value) => { value.status = "needs_attention"; value.error = "Interrupted command launch has no confirmed process identity. Inspect local workers before resuming; no duplicate command was started."; });
    } else {
      const currentBirth = await birthOf(row.pid);
      if ((!row.birth && currentBirth) || (!currentBirth && possiblyAlive(row.pid))) {
        const sprint = getSprint(row.sprint_id);
        if (sprint.status !== "paused") updateSprint(sprint.id, sprint.revision, (value) => { value.status = "needs_attention"; value.error = "Interrupted command identity was not fully recorded. Inspect workers before resuming; no duplicate command was launched."; });
      } else if (row.birth && currentBirth === row.birth) {
        try { process.kill(-row.pid, "SIGKILL"); } catch { /* exited before termination */ }
      }
    }
    db.run("UPDATE sprint_commands SET completed = 1 WHERE id = ?", [row.id]);
  }
}

function kill(proc: Bun.Subprocess) {
  try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }
}

export function stopSprintCommands(id: string): void {
  for (const proc of processes.get(id) ?? []) kill(proc);
}

async function boundedText(stream: ReadableStream<Uint8Array>): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let text = "", truncated = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.length > 128_000) { text = text.slice(-128_000); truncated = true; }
  }
  return { text: text + decoder.decode(), truncated };
}

/** No shell interpolation. Checks inherit the core's scrubbed environment.
 * A process group lets pause and timeout terminate descendants as well. */
export async function sprintCommand(id: string, cwd: string, argv: string[], timeoutMs: number = SPRINT_LIMITS.attemptMs, extraEnv: Record<string, string> = {}): Promise<SprintCommandResult> {
  if (getSprint(id).status === "paused") throw new Error("Sprint paused");
  const startedAt = Date.now();
  const lease = randomUUID();
  db.run("INSERT INTO sprint_commands (id, sprint_id) VALUES (?, ?)", [lease, id]);
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try { proc = coreSpawn(argv, { cwd, env: childEnv({ ...extraEnv, CI: "true", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }), detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" }) as Bun.Subprocess<"ignore", "pipe", "pipe">; }
  catch (error) { db.run("UPDATE sprint_commands SET completed = 1 WHERE id = ?", [lease]); throw error; }
  db.run("UPDATE sprint_commands SET pid = ? WHERE id = ?", [proc.pid, lease]);
  const active = processes.get(id) ?? new Set(); active.add(proc); processes.set(id, active);
  const timer = setTimeout(() => kill(proc), timeoutMs);
  try {
    const birth = await birthOf(proc.pid);
    db.run("UPDATE sprint_commands SET birth = ? WHERE id = ?", [birth, lease]);
    const [stdout, stderr, exitCode] = await Promise.all([boundedText(proc.stdout), boundedText(proc.stderr), proc.exited]);
    return { argv, startedAt, endedAt: Date.now(), exitCode, output: `${stdout.text}${stderr.text}`, truncated: stdout.truncated || stderr.truncated };
  } catch (error) { kill(proc); await proc.exited; throw error; }
  finally { db.run("UPDATE sprint_commands SET completed = 1 WHERE id = ?", [lease]); clearTimeout(timer); active.delete(proc); if (active.size === 0) processes.delete(id); }
}

export async function sprintGit(id: string, cwd: string, args: string[]): Promise<string> {
  const result = await sprintCommand(id, cwd, ["git", ...args], 120_000);
  if (result.exitCode !== 0 || result.truncated) throw new Error(`Git ${args[0]} failed: ${result.output.slice(-4000)}`);
  return result.output.trim();
}
