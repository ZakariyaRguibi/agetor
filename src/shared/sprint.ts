/** Native sprint contracts. Runtime state is core-owned, never trusted from an agent or HTTP body. */
export interface SprintTicket {
  key: string;
  title: string;
  prompt: string;
  acceptance: string[];
  dependencies: string[];
}
export interface SprintCheck { name: string; argv: string[] }
export interface SprintInput {
  name: string;
  workdir: string;
  prompt: string;
  specification: string;
  tickets: SprintTicket[];
  selected: string[];
  profiles: { planner: string; tickets: string; implementer: string; reviewer: string; escalation: string | null };
  checks: SprintCheck[];
  shipping: { repository: string; base: string; requiredChecks: string[]; enabled: boolean };
  includedOnly: boolean;
}
export type SprintStatus = "draft" | "running" | "paused" | "waiting_quota" | "needs_attention" | "verifying" | "shipping" | "completed";
export type SprintTicketStatus = "queued" | "implementing" | "checking" | "reviewing" | "passed" | "failed";
export interface SprintTicketState {
  status: SprintTicketStatus;
  taskId: string | null;
  reviewTaskId: string | null;
  startedAt: number | null;
  repairs: number;
  attempts: number;
  candidate: string | null;
  reviewed: string | null;
  error: string | null;
  retryAt: number | null;
  checks: { name: string; argv: string[]; exitCode: number; startedAt: number; endedAt: number; output: string }[];
  reviewFallback: boolean;
  quotaFailures: number;
}
export interface Sprint {
  id: string;
  revision: number;
  input: SprintInput;
  status: SprintStatus;
  specApproval: string | null;
  batchApproval: string | null;
  state: Record<string, SprintTicketState>;
  branch: string | null;
  integrationTaskId: string | null;
  planningTaskId: string | null;
  ticketingTaskId: string | null;
  prUrl: string | null;
  mergeSha: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  lastNotice?: string;
  releasePollAt?: number;
}
export const SPRINT_LIMITS = { agents: 3, attemptMs: 20 * 60_000, repairs: 3, tickets: 100 } as const;

function text(value: unknown, field: string, max = 100_000, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) throw new Error(`Invalid ${field}`);
  return value;
}
function strings(value: unknown, field: string, max = 100, allowEmpty = true, unique = true): string[] {
  if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) throw new Error(`Invalid ${field}`);
  const result = value.map((item) => text(item, field, 4000));
  if (unique && new Set(result).size !== result.length) throw new Error(`Duplicate ${field}`);
  return result;
}

export function validateSprintInput(raw: unknown): SprintInput {
  if (!raw || typeof raw !== "object") throw new Error("Expected a sprint object");
  const r = raw as Record<string, unknown>;
  const profiles = r.profiles as SprintInput["profiles"];
  const shipping = r.shipping as SprintInput["shipping"];
  if (!profiles || !shipping || typeof shipping.enabled !== "boolean" || typeof r.includedOnly !== "boolean") throw new Error("Missing sprint settings");
  const workdir = text(r.workdir, "repository path", 4096);
  if (!workdir.startsWith("/")) throw new Error("Repository path must be absolute");
  if (!Array.isArray(r.tickets) || r.tickets.length > SPRINT_LIMITS.tickets) throw new Error("Invalid tickets");
  const tickets = r.tickets.map((value) => {
    const ticket = value as SprintTicket;
    if (!ticket || typeof ticket !== "object") throw new Error("Invalid ticket");
    const key = text(ticket.key, "ticket key", 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(key)) throw new Error("Invalid ticket key");
    return { key, title: text(ticket.title, "ticket title", 300), prompt: text(ticket.prompt, "ticket prompt"), acceptance: strings(ticket.acceptance, "acceptance criteria", 100, false), dependencies: strings(ticket.dependencies, "dependencies") };
  });
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  if (byKey.size !== tickets.length) throw new Error("Duplicate ticket key");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error(`Dependency cycle at ${key}`);
    if (visited.has(key)) return;
    const ticket = byKey.get(key);
    if (!ticket) throw new Error(`Unknown dependency ${key}`);
    visiting.add(key);
    ticket.dependencies.forEach(visit);
    visiting.delete(key); visited.add(key);
  };
  tickets.forEach((ticket) => visit(ticket.key));
  const selected = strings(r.selected, "selected tickets");
  for (const key of selected) {
    const ticket = byKey.get(key);
    if (!ticket) throw new Error(`Unknown selected ticket ${key}`);
    for (const dependency of ticket.dependencies) if (!selected.includes(dependency)) throw new Error(`${key} requires selected prerequisite ${dependency}`);
  }
  if (!Array.isArray(r.checks) || r.checks.length > 30) throw new Error("Invalid checks");
  const checks = r.checks.map((value) => {
    const check = value as SprintCheck;
    if (!check || typeof check !== "object") throw new Error("Invalid check");
    return { name: text(check.name, "check name", 200), argv: strings(check.argv, "check argv", 100, false, false) };
  });
  const repository = text(shipping.repository, "GitHub repository", 200, true);
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Expected owner/repository");
  const base = text(shipping.base, "base branch", 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(base) || base.includes("..") || base.includes("//")) throw new Error("Invalid base branch");
  return {
    name: text(r.name, "sprint name", 200), workdir, prompt: text(r.prompt, "product prompt", 100_000, true),
    specification: text(r.specification, "specification", 500_000, true), tickets, selected,
    profiles: { planner: text(profiles.planner, "planner", 200, true), tickets: text(profiles.tickets, "ticket generator", 200, true), implementer: text(profiles.implementer, "implementer", 200, true), reviewer: text(profiles.reviewer, "reviewer", 200, true), escalation: profiles.escalation === null ? null : text(profiles.escalation, "escalation", 200) },
    checks, shipping: { repository, base, requiredChecks: strings(shipping.requiredChecks, "required CI checks"), enabled: shipping.enabled }, includedOnly: r.includedOnly,
  };
}

export function initialTicketState(): SprintTicketState {
  return { status: "queued", taskId: null, reviewTaskId: null, startedAt: null, repairs: 0, attempts: 0, candidate: null, reviewed: null, error: null, retryAt: null, checks: [], reviewFallback: false, quotaFailures: 0 };
}

export function sprintTicketMarkdown(input: SprintInput): string {
  return input.tickets.map((ticket) => `# ${ticket.key}: ${ticket.title}\n\nExecution: ${input.selected.includes(ticket.key) ? "approved for this sprint" : "backlog only; do not execute"}\n\n${ticket.prompt}\n\nAcceptance:\n${ticket.acceptance.map((item) => `- ${item}`).join("\n")}\n\nDependencies: ${ticket.dependencies.join(", ") || "none"}`).join("\n\n");
}

export function selectedSprintTickets(input: SprintInput): SprintTicket[] { return input.tickets.filter((ticket) => input.selected.includes(ticket.key)); }

export function preserveSprintBacklog(existing: SprintTicket[], generated: unknown): unknown {
  if (!Array.isArray(generated)) return generated;
  const keys = new Set(generated.map((ticket) => ticket?.key));
  return [...existing.filter((ticket) => !keys.has(ticket.key)), ...generated];
}

/** Only reviewed prerequisites unlock descendants; a human moving a native card cannot do so. */
export function readySprintTickets(sprint: Sprint, now = Date.now()): SprintTicket[] {
  if (sprint.status !== "running" || !sprint.batchApproval) return [];
  const active = Object.values(sprint.state).filter((state) => ["implementing", "checking", "reviewing"].includes(state.status)).length;
  return sprint.input.tickets.filter((ticket) => {
    const state = sprint.state[ticket.key];
    return sprint.input.selected.includes(ticket.key) && state?.status === "queued" && (!state.retryAt || state.retryAt <= now) && ticket.dependencies.every((key) => {
      const prerequisite = sprint.state[key];
      return prerequisite?.status === "passed" && !!prerequisite.candidate && prerequisite.reviewed === prerequisite.candidate;
    });
  }).slice(0, Math.max(0, SPRINT_LIMITS.agents - active));
}

export function sprintCanShip(sprint: Sprint): boolean {
  return !!sprint.batchApproval && sprint.input.selected.length > 0 && sprint.input.selected.every((key) => {
    const state = sprint.state[key];
    return state?.status === "passed" && !!state.candidate && state.candidate === state.reviewed;
  });
}
