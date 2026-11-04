# Use native sprints in this fork

Native sprints add an approved backlog and dependency scheduler to Agetor. Existing pipelines remain useful for reusable agent graphs; a sprint coordinates a selected set of tickets, each with its own worktree, checks and independent review.

This is experimental source in the ZakariyaRguibi fork. Downloading the upstream Agetor release does not include it. A local installed build includes both pipeline starters and native sprints while retaining existing Agetor data.

For a local installed package, build using `env -u ELECTROBUN_DEVELOPER_ID AGETOR_LOCAL_BUILD=1 bun run build:stable` with system `tmux` on PATH. This produces version `1.1.0-local.2` on the stable data directory, skips maintainer signing/notarization, and disables the upstream update feed. Ad-hoc sign the generated app before installing it. Preserve a backup of the existing app and SQLite database before replacement. The macOS background login-item option requires Developer ID signing and is unavailable in an ad-hoc local build; keep the app open while a sprint runs.

## Start the development app

From this checkout, with Bun installed:

```sh
bun install --frozen-lockfile
bun run dev:hmr
```

The development app uses `~/.agetor-dev` and API port 4318, separate from the installed app's `~/.agetor` and port 4317. Its webview uses port 5173. Close another development instance using those ports before starting. See the repository's contributor/build instructions if native Electrobun or helper prerequisites are missing. A signed distributable has not been built for this feature.

Keep the app running while trying the workflow. A packaged build can use the existing Settings → General → **Keep Agetor running in the background** option; installing that supervisor from this source checkout has not been qualified. Normal Mac sleep is allowed. Agetor reconciles saved sprint state after wake/relaunch; it cannot execute while the Mac is asleep.

## Prepare the repository and accounts

- Use a clean Git checkout with a committed `main` branch and a Git author identity. The Living Atlas product checkout is `/Users/zakariarguibi/Developer/AgentFleetTest`.
- Install and sign in to the Claude Code, Codex and OpenCode CLIs using your included subscriptions. Enable the harnesses in Agetor Settings. The native model/version preflights still apply.
- Keep OpenCode extra usage/auto-recharge, Claude usage credits and Codex additional-credit spending disabled in their accounts. The checkbox records your confirmation; Agetor cannot change or independently verify those account settings.
- Remove API-key or alternate cloud billing overrides from the selected harness environment. Provider credentials remain in their CLI stores outside the repository.
- Do not run the same tickets in another fleet concurrently. The previous Spec Kitty pilot was left needing attention; this fork does not resume or delete it.

## Describe, review, approve, run

Open **Sprints** in the top bar. The app reopens your last saved sprint, and **New sprint** opens a blank draft. Use the four steps across the top:

1. **Brief:** enter a name, absolute repository path and product prompt. Confirm **Use included subscription capacity only**, then click **Generate specification**. This saves the brief and creates missing default profiles if necessary: Sonnet planner, Sol ticket writer, Go DeepSeek builder, Sol reviewer and Terra escalation. Expand **Agent settings** to customize the profiles or create them without running a model. Use **Review or write specification** to paste a spec manually.
2. **Specification:** review the Markdown and resolve open questions. **Edit specification** opens the editable text; **Approve specification** saves it and takes you to Tickets.
3. **Tickets:** click **Generate tickets** if the backlog is empty. Expand individual tickets to review instructions, acceptance criteria and dependencies. Select only the intended batch; selecting a ticket includes its prerequisites. Expand **Verification commands** to check or edit the commands. For the original foundation pilot, select LA-01, LA-02, LA-03 and LA-08 only if those items are still outstanding. Use **Review batch** to save the draft and proceed.
4. **Review & run:** review the selected titles and delivery choice. Use the visible **Before approval** list to resolve missing settings. Choose a local branch or GitHub PR/merge. Click **Approve batch**, read the concrete confirmation, then **Run sprint** when ready. The same screen displays progress and expandable execution evidence.

**Save draft** never starts or regenerates anything. It preserves completed planning and the current specification approval unless the brief/spec changes. A pre-run draft paused during generation can be saved and approved again without starting a model. Use an explicit **Generate** button only when you want a new generation pass. Batch approval records permission; **Run sprint** starts implementation.

Commands are direct argv arrays. Enter one argument per line; shell operators and glob expansion are literal. Include worktree setup, tests, lint, type checks, builds and smoke checks as appropriate. Keep Linux provisioning and machine-wide configuration out of the local checks. UI changes require an approved browser/e2e check.

## Enable automatic shipping

Automatic shipping is off in a new draft for local trials. To enable it, supply `owner/repository`, base `main`, the exact required hosted CI check names, and select **Open one GitHub PR and merge after green CI** before batch approval. The final confirmation includes commit, push, one PR and automatic squash merge after successful verification.

The repository must have a matching GitHub `origin`, authenticated `gh` access, squash merging enabled, and **classic branch protection** requiring up-to-date checks with **administrator enforcement**. The GitHub account must be able to read that protection. Agetor checks this before starting implementation and again before merging; it does not alter repository rules. Rulesets-only protection and repositories without this policy are currently unsupported for automatic shipping. Disable shipping to try local execution instead.

All selected tickets must pass their own checks and independent source-matched review. Agetor assembles them on one sprint branch, updates Markdown setup/architecture/changelog/report documentation, runs the approved checks again, incorporates current remote main, and obtains a fresh independent final review. It then pushes one PR. Missing, pending or skipped required CI does not count as success. Red CI uses the bounded final repair budget. A head change or new base invalidates verification. No incomplete sprint ships.

After GitHub confirms the squash merge, Agetor fetches main, confirms the merge is an ancestor of remote main, and fast-forwards the clean local checkout. A dirty or diverged checkout is preserved and stops completion for attention. Deployment is outside this workflow. With shipping disabled, completion leaves verified work on the local sprint branch.

## Pause, recover and revise

Use **Pause** to stop launches and request cancellation of active models/commands. Replacement workers wait for the previous worker in the same workspace to finish stopping. Explicit pauses survive app restarts. **Resume** continues saved progress; it does not grant approval to changed requirements or reset repair budgets.

Limits are three active agents, 20 minutes per attempt and three repair rounds per ticket, including provider fallback. Sol and Terra share your Codex allowance. A quota failure may try the configured suitable included fallback, then waits for a reported reset or increases its retry delay. Fallbacks count against the repair budget. Failed tickets block their dependents while unrelated eligible tickets continue. The sprint cannot release until every selected ticket passes.

For a scope or architecture change, conflicting merge, authentication problem or exhausted budget, inspect the reported error and native task transcript. Pause, wait for workers to stop, edit the draft and reapprove the specification/batch as required. Edits preserve ticket repair counts, including temporarily removed tickets; exhaustion is not cleared by Resume. Conflicts need human resolution in the named worktree, with all work preserved. A truly new scope belongs in a new approved sprint.

The rare **unconfirmed command identity** recovery message requires inspecting local workers before Resume: Agetor deliberately does not launch a duplicate or kill an unidentified process. Resolve a stale Git lock only after confirming no Git process still owns it. Reopening Agetor uses existing native task identities and completed commits. Sprint-managed tasks/worktrees cannot be independently deleted or rebound through the ordinary task API.

Notifications cover blockers, significant failures and completion; routine per-ticket progress notifications are suppressed. Pending native answer cards remain available. Credentials and provider CLI configuration are not written into the approved Markdown packet.

## Artifacts and validation bounds

The complete backlog is retained in the packet, with selected and backlog-only tickets clearly marked. Approved artifacts are versioned under `docs/sprints/<sprint-id>/spec.md` and `tickets.md`; completion adds `report.md`, plus project setup/changelog/architecture changes. Execution state, attempts, review evidence and command leases live in Agetor's local SQLite database. Keep that data and its native worktrees until the sprint is reconciled.

[Architecture/API reference](architecture/sprints.md) and [qualification evidence](qa/native-sprints.md) distinguish tested fixtures from unverified live behavior. A real subscription-provider pilot, real hosted CI/merge and a signed native build remain to be qualified before treating this fork as unattended production tooling.
