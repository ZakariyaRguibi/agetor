import { Database } from "bun:sqlite";
import path from "node:path";
import { test, expect } from "./fixtures";
import { gotoApp } from "./helpers";
import { initialTicketState, type Sprint } from "../src/shared/sprint";
import { sprintFixture } from "../src/test-sprint-fixture";

test("guided sprint approval keeps draft saves inert and preserves edits", async ({ page, backend }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1250, height: 900 });
  await gotoApp(page, backend.bootBase);
  const open = () => page.getByTestId("sprints-button").click();
  await open();
  const main = page.getByTestId("sprints-page");
  const nav = main.getByRole("navigation", { name: "Sprint steps" });
  const save = () => main.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Brief", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run task", exact: true })).not.toBeVisible();
  await main.getByRole("textbox", { name: "Sprint name", exact: true }).fill("Living Atlas pilot");
  await main.getByRole("textbox", { name: "Repository path", exact: true }).fill("/tmp/living-atlas-sprint-fixture");
  await main.getByRole("textbox", { name: "Product prompt", exact: true }).fill("A deterministic fantasy world simulator");
  await main.getByRole("checkbox", { name: /Use included subscription capacity only/ }).check();
  await save();
  await expect(main.getByText("Draft saved. No agents started.", { exact: true })).toBeVisible();
  await main.getByText("Agent settings", { exact: true }).click();
  await main.getByRole("button", { name: "Create missing sprint agents", exact: true }).click();
  await expect(main.getByRole("combobox", { name: "reviewer agent", exact: true })).not.toHaveValue("");

  await main.getByRole("button", { name: "Review or write specification", exact: true }).click();
  await main.getByRole("textbox", { name: "Sprint specification", exact: true }).fill("# Sprint one\nFoundation, contracts, seeded RNG and saves.");
  await main.getByRole("button", { name: "Approve specification", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Tickets", exact: true })).toBeVisible();
  for (const [index, key, title, instructions, acceptance] of [[1, "LA-01", "Foundation", "Build scaffold", "Build succeeds"], [2, "LA-02", "Contracts", "Define contracts", "Types compile"]] as const) {
    await main.getByRole("button", { name: "Add ticket", exact: true }).click();
    await main.getByRole("textbox", { name: "Ticket " + index + " key", exact: true }).fill(key);
    await main.getByRole("textbox", { name: "Ticket " + index + " title", exact: true }).fill(title);
    await main.getByRole("textbox", { name: "Ticket " + index + " instructions", exact: true }).fill(instructions);
    await main.getByRole("textbox", { name: "Ticket " + index + " acceptance criteria", exact: true }).fill(acceptance);
  }
  await main.getByRole("textbox", { name: "Ticket 2 prerequisites", exact: true }).fill("LA-01");
  await main.getByRole("checkbox", { name: "Include LA-02 in sprint", exact: true }).check();
  await expect(main.getByRole("checkbox", { name: "Include LA-01 in sprint", exact: true })).toBeChecked();
  await main.getByRole("button", { name: "Ticket 1: Foundation", exact: true }).click();
  await main.getByRole("textbox", { name: "Ticket 1 key", exact: true }).fill("LA-BASE");
  await expect(main.getByText("After LA-BASE", { exact: true })).toBeVisible();
  await expect(main.getByRole("checkbox", { name: "Include LA-BASE in sprint", exact: true })).toBeChecked();
  await main.getByRole("textbox", { name: "Ticket 1 key", exact: true }).fill("LA-01");
  await main.getByText("Verification commands · 0", { exact: true }).click();
  await main.getByRole("button", { name: "Add command", exact: true }).click();
  await main.getByRole("textbox", { name: "Check 1 name", exact: true }).fill("Tests");
  await main.getByRole("textbox", { name: "Check 1 program", exact: true }).fill("bun");
  await main.getByRole("textbox", { name: "Check 1 arguments", exact: true }).fill("test");
  await main.getByRole("button", { name: "Review batch", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Review & run", exact: true })).toBeVisible();

  // Reproduce the saved state of a completed generation and paused sprint.
  // The fixture is isolated; neither generation agent is actually launched.
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try {
    const row = db.query<{ id: string; payload: string }, []>("SELECT id, payload FROM sprints").get()!;
    const saved = JSON.parse(row.payload) as Sprint;
    saved.status = "paused";
    saved.state["@plan"] = { ...initialTicketState(), status: "passed", attempts: 1 };
    saved.state["@tickets"] = { ...initialTicketState(), status: "passed", attempts: 1 };
    saved.revision++;
    db.run("UPDATE sprints SET payload = ?, revision = ? WHERE id = ?", [JSON.stringify(saved), saved.revision, saved.id]);
    await page.reload();
    await open();
    await nav.getByRole("button", { name: /Review & run/ }).click();
    await main.getByRole("radio", { name: "Open one GitHub PR and merge after green CI" }).check();
    await expect(main.getByText("Enter the GitHub repository and exact required CI check names.", { exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Approve batch", exact: true })).toBeDisabled();
    await save();
    await expect(main.getByText("Draft saved. No agents started.", { exact: true })).toBeVisible();
    const afterSave = JSON.parse(db.query<{ payload: string }, [string]>("SELECT payload FROM sprints WHERE id = ?").get(saved.id)!.payload) as Sprint;
    expect(afterSave.status).toBe("draft");
    expect(afterSave.specApproval).toBe(saved.specApproval);
    expect(afterSave.state["@plan"]?.status).toBe("passed");
    expect(afterSave.state["@tickets"]?.status).toBe("passed");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(0);

    await main.getByRole("radio", { name: "Keep verified work on a local branch" }).check();
    await main.getByRole("button", { name: "Approve batch", exact: true }).click();
    const approval = page.getByRole("dialog", { name: "Approve this sprint batch?", exact: true });
    await expect(approval).toContainText("2 tickets: LA-01, LA-02");
    await approval.getByRole("button", { name: "Approve exact batch", exact: true }).click();
    await expect(main.getByRole("button", { name: "Run sprint", exact: true })).toBeEnabled();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()!.n).toBe(0);
    await page.screenshot({ path: test.info().outputPath("sprint-review.png") });

    await page.setViewportSize({ width: 760, height: 820 });
    await nav.getByRole("button", { name: /Tickets/ }).focus();
    await page.keyboard.press("Enter");
    await expect(main.getByRole("heading", { name: "Tickets", exact: true })).toBeFocused();
    await expect(main.getByRole("textbox", { name: "Ticket 1 instructions", exact: true })).toHaveCount(0);
    expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("sprint-tickets-narrow.png") });

    await nav.getByRole("button", { name: /Brief/ }).click();
    await main.getByRole("textbox", { name: "Sprint name", exact: true }).fill("Unsaved revision");
    await page.getByRole("button", { name: "Pipelines", exact: true }).click();
    const discard = page.getByRole("dialog", { name: "Discard unsaved sprint changes?", exact: true });
    await expect(discard).toBeVisible();
    await discard.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(main.getByRole("textbox", { name: "Sprint name", exact: true })).toHaveValue("Unsaved revision");
    await page.reload();
    await open();
    await expect(main.getByRole("button", { name: "Run sprint", exact: true })).toBeEnabled();
    await nav.getByRole("button", { name: /Brief/ }).click();
    await expect(main.getByRole("textbox", { name: "Sprint name", exact: true })).toHaveValue("Living Atlas pilot");

  } finally { db.close(); }
});

test("a failed sprint shows review findings and opens the review log", async ({ page, backend }) => {
  const headers = { authorization: "Bearer " + backend.apiToken };
  const created = await page.request.post(backend.apiBase + "/sprints", {
    headers, data: { ...sprintFixture(), workdir: backend.dataDir },
  });
  expect(created.ok()).toBe(true);
  const sprint = await created.json() as Sprint;
  const review = await page.request.post(backend.apiBase + "/tasks", {
    headers,
    data: { title: "Fixture independent review", prompt: "Inspect browser evidence", workdir: backend.dataDir, isolation: "none", agent: "claude-code" },
  });
  expect(review.ok()).toBe(true);
  const reviewTask = await review.json() as { id: string };
  sprint.status = "needs_attention";
  sprint.integrationTaskId = reviewTask.id;
  sprint.state["LA-01"] = {
    ...initialTicketState(), status: "failed", repairs: 3, reviewTaskId: reviewTask.id,
    error: 'Review blocked: {"findings":[{"priority":"P1","message":"Show the negative browser smoke result."}]}',
  };
  sprint.revision++;
  const db = new Database(path.join(backend.dataDir, "agetor.sqlite"));
  try { db.run("UPDATE sprints SET payload = ?, revision = ? WHERE id = ?", [JSON.stringify(sprint), sprint.revision, sprint.id]); }
  finally { db.close(); }

  await gotoApp(page, backend.bootBase);
  await page.getByTestId("sprints-button").click();
  const failures = page.getByRole("region", { name: "Sprint failures" });
  await expect(failures.getByText("P1 · Show the negative browser smoke result.")).toBeVisible();
  await failures.getByRole("button", { name: "Open review log" }).click();
  await expect(page.locator("aside").last()).toContainText("Fixture independent review");
});
