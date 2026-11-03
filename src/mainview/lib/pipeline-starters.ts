import { newStep } from "../../shared/pipeline.ts";
import type { PipelineInput } from "../../shared/types.ts";

export const PIPELINE_STARTERS = [
  {
    id: "plan-build-review",
    name: "Plan → Build → Review",
    description: "Inspect the task, write a plan, implement it, and review the changes.",
  },
  {
    id: "build-verify-review",
    name: "Build → Verify → Review",
    description: "Implement a defined task, run the project checks, and review the result.",
  },
] as const;

export type PipelineStarterId = (typeof PIPELINE_STARTERS)[number]["id"];

const BOUNDARIES = "Do not commit, push, open a pull request, merge, or deploy. Leave shipping to a separately authorized action.";
const BLOCKED = 'If you cannot complete this step, set the handoff status to "blocked" and explain the missing input or failure. Never claim a check passed without evidence.';

const PLAN = [
  "Inspect the repository and the task's requirements. Write a concise implementation plan with acceptance criteria, implementation boundaries, relevant files, and verification commands.",
  "Plan only; do not edit product code. Return consequential scope or architecture questions to the user before implementation by marking the handoff blocked.",
  BOUNDARIES,
  BLOCKED,
].join("\n\n");

const BUILD = [
  "Implement the task using the repository's conventions and any preceding plan. Preserve unrelated work. Add focused tests and update relevant documentation.",
  "Run the relevant checks available in the repository. Include changed paths, exact commands, results, and any remaining limitations in the handoff so the next step can verify them.",
  BOUNDARIES,
  BLOCKED,
].join("\n\n");

const VERIFY = [
  "Verify the implementation against the task's acceptance criteria. Run the relevant tests, lint, type checks, and build commands that exist in the repository; check browser behavior for UI changes when tools are available.",
  "Do not change product source to make checks pass. Record the exact commands, exit codes, and missing checks in the handoff. A failed check or required check that could not run blocks this step.",
  BOUNDARIES,
  BLOCKED,
].join("\n\n");

const REVIEW = [
  "Review the actual changes, including uncommitted and untracked files, against the task and acceptance criteria. Check correctness, regressions, maintainability, and the preceding verification evidence. Do not edit source files.",
  'Give an explicit PASS or REQUEST_CHANGES verdict in the handoff summary. Only PASS may use status "done". Unresolved findings or missing verification evidence require status "blocked", with actionable findings and affected files. An agent exiting successfully is not proof that its checks passed.',
  BOUNDARIES,
].join("\n\n");

/** A starter is an unsaved editor draft, with no account or model selected.
 * Fresh identities keep separate uses independent, including canvas state.
 * See docs/architecture/pipelines.md. */
export function createPipelineStarter(id: PipelineStarterId): PipelineInput {
  const starter = PIPELINE_STARTERS.find((item) => item.id === id)!;
  const roles = id === "plan-build-review"
    ? [["Plan", PLAN], ["Build", BUILD], ["Review", REVIEW]] as const
    : [["Build", BUILD], ["Verify", VERIFY], ["Review", REVIEW]] as const;
  const steps = roles.map(([name, instructions], index) => newStep({
    name,
    instructions,
    position: { x: index * 320, y: 0 },
  }));
  const edges = steps.slice(1).map((step, index) => ({
    id: crypto.randomUUID(),
    from: steps[index]!.id,
    to: step.id,
    label: "",
  }));
  return {
    name: starter.name,
    description: starter.description,
    maxSteps: steps.length,
    graph: { steps, edges, startStepId: steps[0]!.id },
  };
}
