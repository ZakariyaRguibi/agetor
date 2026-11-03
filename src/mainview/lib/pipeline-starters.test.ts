import { describe, expect, test } from "bun:test";
import { resolveNextSteps, resolveStartStep, validatePipelineGraph } from "../../shared/pipeline.ts";
import { createPipelineStarter, PIPELINE_STARTERS } from "./pipeline-starters";

describe("pipeline starters", () => {
  for (const starter of PIPELINE_STARTERS) {
    test(`${starter.name} is a valid sequential draft with no agents selected`, () => {
      const draft = createPipelineStarter(starter.id);
      expect(validatePipelineGraph(draft.graph).ok).toBe(true);
      expect(draft.maxSteps).toBe(3);
      expect(draft.graph.steps.every((step) => step.agentProfileId === null && step.subagents.profileIds.length === 0)).toBe(true);
      expect(draft.graph.steps.map((step) => step.name).join(" → ")).toBe(starter.name);
      expect(resolveStartStep(draft.graph)).toEqual(draft.graph.steps[0]!);
      for (const [index, step] of draft.graph.steps.entries()) {
        const next = resolveNextSteps(draft.graph, step.id, null);
        expect(next).toEqual(index === 2
          ? { kind: "terminal" }
          : { kind: "steps", stepIds: [draft.graph.steps[index + 1]!.id] });
      }
    });
  }

  test("repeated uses have independent graph identities and mutable state", () => {
    const first = createPipelineStarter("plan-build-review");
    const second = createPipelineStarter("plan-build-review");
    const ids = [...first.graph.steps, ...first.graph.edges, ...second.graph.steps, ...second.graph.edges].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    first.graph.steps[0]!.subagents.profileIds.push("changed");
    first.graph.steps[0]!.position.x = 200;
    expect(second.graph.steps[0]!.subagents.profileIds).toEqual([]);
    expect(second.graph.steps[0]!.position.x).toBe(0);
  });
});
