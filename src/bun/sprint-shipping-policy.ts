import type { Sprint } from "../shared/sprint.ts";
import { sprintCommand } from "./sprint-command.ts";

export function requireSprintShippingPolicy(value: unknown): void {
  const policy = value as { required_status_checks?: { strict?: boolean }; enforce_admins?: { enabled?: boolean } };
  if (!policy?.required_status_checks?.strict || !policy.enforce_admins?.enabled) throw new Error("Automatic shipping requires strict up-to-date branch checks with administrator enforcement on the base branch");
}

/** Read-only preflight: fail before consuming model capacity if shipping
 * cannot enforce a verified base. Never changes repository rules. */
export async function checkSprintShippingPolicy(sprint: Sprint): Promise<void> {
  if (!sprint.input.shipping.enabled) return;
  const result = await sprintCommand(sprint.id, sprint.input.workdir, ["gh", "api", "--hostname", "github.com", `repos/${sprint.input.shipping.repository}/branches/${encodeURIComponent(sprint.input.shipping.base)}/protection`], 30_000);
  if (result.exitCode !== 0) throw new Error("Unable to verify shipping branch protection. Configure strict required checks with administrator enforcement, or disable automatic shipping for a local trial.");
  requireSprintShippingPolicy(JSON.parse(result.output));
}
