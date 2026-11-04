import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGETOR_DATA_DIR = mkdtempSync(join(tmpdir(), "agetor-sprint-routing-"));
const { buildCommand } = await import("./agents.ts");
const { harnesses } = await import("./db.ts");

test("managed Codex commands pin ChatGPT/OpenAI and disable delegation; ordinary commands keep their settings", () => {
  const harness = harnesses.get("codex")!;
  const options = { model: "gpt-6.1-sol", effort: "medium", mode: "ask" };
  const managed = buildCommand(harness, "review", { ...options, sprintManaged: true });
  expect(managed.cmd).toContain("forced_login_method=chatgpt");
  expect(managed.cmd).toContain("model_provider=openai");
  expect(managed.cmd).toContain("features.multi_agent=false");
  expect(managed.cmd).toContain("read-only");
  expect(buildCommand(harness, "ordinary task", options).cmd).not.toContain("forced_login_method=chatgpt");
});
test("managed OpenCode pins the Go provider and small model without modifying harness settings", () => {
  const harness = { ...harnesses.get("opencode")!, env: { OPENCODE_CONFIG_CONTENT: '{"model":"original"}' } };
  const model = "opencode-go/deepseek-v4.1-flash";
  const managed = buildCommand(harness, "build", { model, mode: "auto", cliVersion: "2.2.5", opencodeServer: "standalone", sprintManaged: true });
  const config = JSON.parse(managed.env!.OPENCODE_CONFIG_CONTENT!);
  expect(config.enabled_providers).toEqual(["opencode-go"]);
  expect(config.model).toBe(model); expect(config.small_model).toBe(model); expect(config.permission.task).toBe("deny");
  expect(managed.cmd).toContain("--standalone");
  expect(harness.env.OPENCODE_CONFIG_CONTENT).toBe('{"model":"original"}');
});
test("managed Claude commands disable Agent/Task delegation", () => {
  const command = buildCommand(harnesses.get("claude-code")!, "plan", { model: "sonnet", effort: "medium", mode: "plan", sprintManaged: true });
  expect(command.cmd).toContain("--disallowedTools"); expect(command.cmd).toContain("Agent"); expect(command.cmd).toContain("Task");
});
