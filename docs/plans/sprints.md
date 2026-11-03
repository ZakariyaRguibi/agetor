# Native sprint workflow

Implement the approved sprint workflow in Agetor. Reuse native tasks, agent profiles, worktrees, event history and core boot ownership. Keep existing tasks and pipelines compatible. The installed app's database is not used for development or tests.

## Contract

A sprint holds a repository, product prompt, versioned specification, editable tickets with stable keys, selected ticket keys, named agent profiles, argv-based verification commands and shipping settings. Draft → specification approved → exact ticket batch approved → running → verifying → shipping → completed. Pause, quota waiting and needs-attention states are durable. Editing approved inputs invalidates approval. Only desktop callers can approve, run, resume or authorize shipping; agents cannot approve their own work through the readable CLI token.

Tickets form an acyclic graph. Selecting a ticket requires selecting every prerequisite. Each ticket has its own native task and worktree, starting at the reviewed prerequisite commits. Review completion requires an explicit verdict tied to the candidate tree, with passing deterministic checks. Exit zero alone, a board column change or a stale verdict is insufficient. Failed tickets block descendants while other eligible tickets continue. At most three model tasks run across a sprint; attempts time out after 20 minutes and a ticket has at most three repair rounds across providers/restarts. Planning and generation use ordinary native tasks, then import validated structured output into an editable draft; neither may execute generated tickets.

Execution state is persisted before side effects. Reconciliation reuses existing native task/run identities and git commits rather than creating duplicate workers. Explicit pause survives restart. Native tmux sessions survive app restarts and normal Mac sleep. Reported quota reset times take precedence over bounded exponential backoff. No extra paid provider is chosen automatically. Profiles/models and subscription-only attestation are included in approval; unknown billing routes block launching.

All reviewed tickets assemble on one sprint branch. Documentation/setup, relevant decisions, changelog and sprint report are updated before final verification and independent review. Fetch current main, incorporate it without automatic conflict resolution, rerun checks/review on that revision, push one sprint PR, wait for all explicitly required CI checks, and squash merge using a head-SHA lease. Missing, skipped, stale or failing required checks block shipping. Confirm remote main contains the merge before fast-forwarding a clean local checkout. A dirty checkout is preserved and reported. Repeated release/recovery cannot produce duplicate PRs/merges. No deployment.

## Qualification

Use disposable local repositories and simulated native agents to test dependency code inheritance, parallel worktrees, caps, missing/rejected/stale verdicts, failed checks, repairs, conflicts, changed approvals, quotas, interruption, pause and release idempotency. Browser tests cover the full review/edit/approve/run flow with fake harnesses. Real model/GitHub runs require a concrete approved batch; do not infer approval for new Living Atlas changes from approval to implement Agetor.

## Implementation slices

1. Validated sprint/ticket contracts, additive persistence and approval hashing.
2. Desktop controls, API authorization and editable sprint/ticket UI.
3. Native-task planning/generation and structured artifact import.
4. Dependency scheduler, git integration, deterministic checks, source-matched review and bounded repair.
5. Quota handling, durable reconciliation, notifications and pause/resume.
6. Final documentation/verification/review, idempotent PR/CI/merge and local sync.

Mark a slice complete only after its integration tests pass; describe remaining gaps honestly.
