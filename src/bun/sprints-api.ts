import { approveSprintBatch, approveSprintSpec, createSprint, editSprint, getSprint, listSprints } from "./sprint-store.ts";
import { sprintControl } from "./sprint-controller.ts";

export { getSprint, listSprints };

export async function sprintRequest(method: "create" | "edit" | "action", id: string | null, raw: unknown) {
  if (method === "create") return createSprint(raw);
  const body = raw as { revision?: number; input?: unknown; action?: string };
  if (!body || !Number.isSafeInteger(body.revision) || body.revision! < 1 || !id) throw new Error("Expected current sprint revision");
  if (method === "edit") return editSprint(id, body.revision!, body.input);
  if (body.action === "approve-spec") return approveSprintSpec(id, body.revision!);
  if (body.action === "approve-batch") return approveSprintBatch(id, body.revision!);
  return sprintControl(id, body.revision!, body.action ?? "");
}
