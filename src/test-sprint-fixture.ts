import type { SprintInput } from "./shared/sprint.ts";

export function sprintFixture(): SprintInput {
  return { name: "Pilot", workdir: "/tmp/product", prompt: "World simulator", specification: "Approved architecture", tickets: [
    { key: "LA-01", title: "Foundation", prompt: "Build foundation", acceptance: ["Build works"], dependencies: [] },
    { key: "LA-02", title: "Contracts", prompt: "Add contracts", acceptance: ["Types work"], dependencies: ["LA-01"] },
    { key: "LA-03", title: "RNG", prompt: "Add RNG", acceptance: ["Seeded replay works"], dependencies: ["LA-02"] },
    { key: "LA-08", title: "Save", prompt: "Add save", acceptance: ["Round trip works"], dependencies: ["LA-02"] },
  ], selected: ["LA-01", "LA-02", "LA-03", "LA-08"], profiles: { planner: "planner", tickets: "tickets", implementer: "builder", reviewer: "reviewer", escalation: null }, checks: [{ name: "Tests", argv: ["bun", "test"] }], shipping: { repository: "owner/product", base: "main", requiredChecks: ["checks"], enabled: true }, includedOnly: true };
}
