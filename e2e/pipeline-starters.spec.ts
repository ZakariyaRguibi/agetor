import { test, expect, type E2EBackend, type Page } from "./fixtures";
import { gotoApp, putPreference } from "./helpers";
import type { Pipeline, Task } from "../src/shared/types";

async function list<T>(backend: E2EBackend, resource: string): Promise<T[]> {
  const response = await fetch(`${backend.apiBase}/${resource}`, {
    headers: { authorization: `Bearer ${backend.apiToken}` },
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function expectStepsInCanvas(page: Page): Promise<void> {
  await expect(async () => {
    const canvas = (await page.getByTestId("pipeline-canvas").boundingBox())!;
    for (const node of await page.getByTestId("pipeline-step-node").all()) {
      const bounds = (await node.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(canvas.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(canvas.x + canvas.width);
      expect(bounds.y).toBeGreaterThanOrEqual(canvas.y);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(canvas.y + canvas.height);
    }
  }).toPass({ timeout: 10_000 });
}

test("a keyboard-selected starter is an unsaved draft; Save persists it without starting agents", async ({ page, backend }) => {
  const beforePipelines = await list<Pipeline>(backend, "pipelines");
  const beforeTasks = await list<Task>(backend, "tasks");
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoApp(page, backend.bootBase);
  await page.getByTestId("pipelines-button").click();
  await page.getByTestId("pipelines-new").click();
  const starter = page.getByRole("button", { name: "Use Plan → Build → Review template", exact: true });
  await starter.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pipeline-name")).toHaveValue("Plan → Build → Review");
  await expect(page.getByTestId("pipeline-step-node")).toHaveCount(3);
  await expect(page.getByTestId("pipeline-max-steps")).toHaveValue("3");
  await expect(starter).toBeFocused();
  await expectStepsInCanvas(page);
  expect(await list(backend, "pipelines")).toEqual(beforePipelines);
  expect(await list(backend, "tasks")).toEqual(beforeTasks);
  await page.screenshot({ path: test.info().outputPath("starter-draft.png"), fullPage: true });

  const name = `Starter ${Date.now()}`;
  await page.getByTestId("pipeline-name").fill(name);
  await page.getByTestId("pipeline-save").click();
  await expect(page.getByTestId("pipelines-page")).toBeVisible();
  const saved = (await list<Pipeline>(backend, "pipelines")).find((pipeline) => pipeline.name === name)!;
  expect(saved).toBeTruthy();
  expect(saved.graph.steps.map((step) => step.name)).toEqual(["Plan", "Build", "Review"]);
  expect(saved.graph.steps.every((step) => step.agentProfileId === null)).toBe(true);
  expect(await list(backend, "tasks")).toEqual(beforeTasks);

  await page.reload();
  await page.getByTestId("pipelines-button").click();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByTestId("pipeline-step-node")).toHaveCount(3);
  await expect(page.getByTestId("pipeline-starters")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("switching starters preserves edits on cancel and keeps the normal dirty-draft guard", async ({ page, backend, request }) => {
  await putPreference(request, backend, "theme", "dark");
  await page.setViewportSize({ width: 1024, height: 768 });
  await gotoApp(page, backend.bootBase);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByTestId("pipelines-button").click();
  await page.getByTestId("pipelines-new").click();
  await page.getByTestId("pipeline-name").fill("My draft");
  await page.getByTestId("pipeline-starter-build-verify-review").click();
  const replace = page.getByRole("dialog", { name: "Replace this draft?", exact: true });
  await replace.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("pipeline-name")).toHaveValue("My draft");
  await expect(page.getByTestId("pipeline-step-node")).toHaveCount(1);

  await page.getByTestId("pipeline-starter-build-verify-review").click();
  await replace.getByRole("button", { name: "Replace draft", exact: true }).click();
  await expect(page.getByTestId("pipeline-name")).toHaveValue("Build → Verify → Review");
  await expect(page.getByTestId("pipeline-step-node")).toHaveCount(3);
  await expect(page.getByTestId("pipeline-starter-plan-build-review")).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId("pipeline-starter-build-verify-review")).toBeInViewport({ ratio: 1 });
  await expectStepsInCanvas(page);
  await page.screenshot({ path: test.info().outputPath("starter-dark-1024.png"), fullPage: true });
  await page.getByTestId("pipeline-back").click();
  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?", exact: true });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("pipeline-name")).toHaveValue("Build → Verify → Review");
});
