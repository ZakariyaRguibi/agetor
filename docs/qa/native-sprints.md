# Native sprint qualification

Status: experimental source implementation; not a qualified unattended release. Tested on macOS with Bun 1.3.11, TypeScript 5.9.3, Vite 8.2.2 and the frozen lockfile. No real provider generation/implementation requests or Living Atlas publishing were made during this feature's qualification.

## Passing local evidence

The final focused command passed **173 tests across 12 files**, with no failures:

```sh
bun test src/shared/sprint.test.ts src/shared/sprint-result.test.ts \
  src/bun/sprint-store.test.ts src/bun/sprint-runner.test.ts \
  src/bun/sprint-native.test.ts src/bun/sprint-command.test.ts \
  src/bun/sprint-routing.test.ts src/bun/sprint-release.test.ts \
  src/bun/sprints-endpoint.test.ts src/bun/route-policy.test.ts \
  src/bun/migrate.test.ts src/bun/core-spawn.test.ts
bun run typecheck
bun node_modules/vite/bin/vite.js build
```

Typecheck and client production build passed. Vite reports its existing future config-loader warning and large-chunk warnings; no signed native application build was attempted.

| Area | Evidence and boundary |
| --- | --- |
| Approval and API | Actual local HTTP tests verify desktop-only mutation/approval, CLI read access, stale revisions, forged approval fields ignored, idempotent profile setup, and refused ordinary managed-task start/edit/delete/rebinding. |
| Graph, limits, quota | Injectable-host tests verify pilot order, parallel downstream eligibility, explicit matching review, rejected/missing verdicts, failed checks, exhausted repairs, changed approvals, quota waiting without duplicate launch, paused recovery and independent work continuing after a failed root. Pure gates count active verification/review slots toward the cap. |
| Worktrees and checks | Disposable real Git repositories verify prerequisite code inheritance, distinct parallel worktrees/branches, passing direct check evidence, idempotent integration, approved packet-change blockers, conflicting integration blockers and unchanged original main. |
| Recovery | Real local subprocess fixtures verify command timeout/cancellation and persisted completion leases; boot recovery kills only an identified matching orphan process group and preserves repair counts. Unknown identity checkpoints instead of duplicating a launch. Saved revisions retain retired ticket budgets and advance internal job identity. The complete backlog stays versioned while generation preserves existing identifiers and final review receives only selected tickets. |
| Routing | Command construction tests verify managed Codex ChatGPT/OpenAI flags, OpenCode Go model/small-model pinning, delegation suppression and unchanged ordinary command behavior. They do not prove account-side spending switches or actual provider/model access. |
| Release | Real Git plus simulated GitHub verify missing/red/skipped CI gates, strict-policy gate, current-main invalidation, one PR/one merge across repeated recovery and clean local main synchronization. No hosted PR merge was used as test evidence. |

The Chromium run of `e2e/sprints.spec.ts` and `e2e/pipeline-starters.spec.ts` passed **3 tests** using the actual webview and isolated fake-agent backend. A final sprint-only rerun also passed after adding a regression for ticket-key renaming: dependent keys and selection follow the rename. The sprint test creates a draft, uses editable ticket/check forms, creates profiles, approves spec and exact batch, observes Run enabled, tests the unsaved-navigation guard and reload persistence. It deliberately does **not** click Run or invoke a real model. Dark-mode rendering was inspected at desktop size.

The multi-worktree integration fixture exceeded Bun's default five-second test timeout once while Chromium and other checks were running. Its timeout was set to twenty seconds for the multiple real Git subprocesses; the full focused rerun passed. Runtime model attempts retain the separate twenty-minute limit.

## Whole-repository regression result

An earlier full `bun test` run completed with **10,954 passed, 31 skipped, 12 failed and one unhandled error** across 454 files. One failure was the old migration-list expectation; that assertion was updated for additive migrations 082–084 and the migration tests now pass.

An unchanged snapshot at starter commit `201a2cc` was tested separately. Eight failures still seen in a focused current run were reproduced on that baseline: five GitHub unauthenticated-path expectations in an environment with installed GitHub credentials, one project-MCP discovery test, one cancellation-reconciliation timeout (also associated with the unhandled error), and one SQLite query-plan expectation. Two background race cases and one GitLab host-alias case failed only in the large run and passed focused reruns; their exact full-suite interactions remain unresolved. This is not a claim that the full suite is green or that every failure is fully diagnosed. Unrelated tests were not weakened to hide those failures.

## Remaining live qualification

- Real subscription auth/model availability and end-to-end structured output for Sonnet, Go DeepSeek, Sol and Terra; actual quota/reset messages and account spending controls.
- A real approved sprint through hosted CI, squash merge and remote/local confirmation, including permissions and branch protection on its target repository.
- Packaged macOS app startup, native helper signing/notifications, background handover, actual sleep/wake and interruption during provider sessions. Local scheduler/process fixtures do not substitute for this evidence.
- Broader repository-suite failures above, and rulesets-only GitHub branch protection (currently blocked rather than accepted).

Existing installed Agetor data and the prior Spec Kitty pilot are preserved. The prior pilot still reports `needs_attention`; do not run it concurrently with a native sprint for the same tickets. See [usage](../sprints.md) before launching any real batch.
