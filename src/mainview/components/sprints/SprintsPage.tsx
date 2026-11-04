import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleAlert, GitPullRequest, Loader2, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { ASSISTANT_MD_COMPONENTS, MD_URL_TRANSFORM } from "@/components/kanban/md-components";
import { api } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { registerLeaveGuard } from "@/lib/leave-guard";
import { selectedSprintTickets, sprintApprovalIssues, SPRINT_DRAFT_JOBS, validateSprintInput, type Sprint, type SprintInput } from "../../../shared/sprint.ts";
import { SprintChecksEditor, SprintDisclosure, SprintTicketsEditor, sprintSelect, sprintTextarea } from "./SprintEditors";

const steps = ["Brief", "Specification", "Tickets", "Review & run"] as const;
const roleLabels = { planner: "Planner", tickets: "Ticket writer", implementer: "Builder", reviewer: "Reviewer", escalation: "Escalation" };
const activeStatuses = ["implementing", "checking", "reviewing"];
const executionStatuses = ["running", "waiting_quota", "verifying", "shipping"];
const statusLabel = { draft: "Draft", paused: "Paused", running: "Running", waiting_quota: "Waiting for quota", verifying: "Verifying", shipping: "Shipping", completed: "Completed", needs_attention: "Needs attention" };
const ticketStatus = { queued: "Queued", implementing: "Building", checking: "Checking", reviewing: "Reviewing", passed: "Passed", failed: "Needs attention" };
const panel = "rounded-xl border border-border bg-card p-4 sm:p-5";

function blank(): SprintInput {
  return { name: "New sprint", workdir: "", prompt: "", specification: "", tickets: [], selected: [], profiles: { planner: "", tickets: "", implementer: "", reviewer: "", escalation: null }, checks: [], shipping: { repository: "", base: "main", requiredChecks: [], enabled: false }, includedOnly: false };
}

function recommendedStep(sprint: Sprint | null): number {
  if (!sprint) return 0;
  if (executionStatuses.includes(sprint.status) || sprint.status === "completed" || sprint.batchApproval || (sprint.integrationTaskId && sprint.status !== "draft")) return 3;
  if (sprint.state["@plan"]?.status === "implementing") return 1;
  if (!sprint.input.specification.trim()) return 0;
  return sprint.specApproval ? 2 : 1;
}

function normalize(input: SprintInput): SprintInput {
  return {
    ...input, name: input.name.trim(), workdir: input.workdir.trim(),
    selected: input.selected.map((key) => key.trim()).filter(Boolean),
    tickets: input.tickets.map((ticket) => ({ ...ticket, key: ticket.key.trim(), acceptance: ticket.acceptance.map((item) => item.trim()).filter(Boolean), dependencies: ticket.dependencies.map((item) => item.trim()).filter(Boolean) })),
    checks: input.checks.map((check) => ({ name: check.name.trim(), argv: [check.argv[0]?.trim() ?? "", ...check.argv.slice(1).filter((arg) => arg !== "")] })),
    shipping: { ...input.shipping, repository: input.shipping.repository.trim(), base: input.shipping.base.trim(), requiredChecks: input.shipping.requiredChecks.map((name) => name.trim()).filter(Boolean) },
  };
}

function SprintProgress({ sprint }: { sprint: Sprint }) {
  const selected = selectedSprintTickets(sprint.input);
  const passed = selected.filter((ticket) => sprint.state[ticket.key]?.status === "passed").length;
  return <div className="space-y-4">
    <section className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{statusLabel[sprint.status]}</h3>
        <span className="text-sm text-muted-foreground">{passed} of {selected.length} tickets passed</span>
      </div>
      <progress aria-label="Tickets passed" className="my-3 h-2 w-full accent-primary" max={Math.max(1, selected.length)} value={passed} />
      <ul className="divide-y divide-border">
        {selected.map((ticket) => <li key={ticket.key} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><span><span className="mr-2 font-mono text-xs text-muted-foreground">{ticket.key}</span>{ticket.title}</span><span className="text-muted-foreground">{ticketStatus[sprint.state[ticket.key]?.status ?? "queued"]}</span></li>)}
      </ul>
      {sprint.prUrl && <a className="mt-3 inline-flex items-center gap-2 text-sm underline underline-offset-4" href={sprint.prUrl} target="_blank" rel="noreferrer"><GitPullRequest aria-hidden className="size-4" />Sprint pull request</a>}
    </section>
    <SprintDisclosure label="Execution evidence">
      {Object.entries(sprint.state).filter(([key, state]) => state.checks.length || state.error || state.retryAt || (key.startsWith("@") && !SPRINT_DRAFT_JOBS.some((job) => job === key))).map(([key, state]) => <details key={key} className="rounded-md border border-border p-3 text-xs">
        <summary className="cursor-pointer font-medium">{key === "@docs" ? "Documentation" : key === "@final" ? "Whole-sprint verification" : key.startsWith("@final-review") ? "Final independent review" : key} · {ticketStatus[state.status]} · {state.repairs}/3 repairs</summary>
        {state.candidate && <p className="mt-2 break-all text-muted-foreground">Candidate {state.candidate} · {state.reviewed === state.candidate ? "reviewed" : "awaiting review"}</p>}
        {state.retryAt && <p className="mt-2">Retry after {new Date(state.retryAt).toLocaleString()}</p>}
        {state.error && <p className="mt-2 whitespace-pre-wrap break-words text-warning">{state.error}</p>}
        {state.checks.map((check, index) => <div key={index} className="mt-3"><p>{check.name} · exit {check.exitCode}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{check.output || "No command output."}</pre></div>)}
      </details>)}
    </SprintDisclosure>
  </div>;
}

export function SprintsPage({ onBack }: { onBack: () => void }) {
  const { profiles, loaded: profilesLoaded, refresh: refreshProfiles } = useAgentProfiles();
  const confirm = useConfirm();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [current, setCurrent] = useState<Sprint | null>(null);
  const [draft, setDraft] = useState<SprintInput>(blank);
  const [step, setStep] = useState(0);
  const [editingSpec, setEditingSpec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const currentRef = useRef(current);
  const busyRef = useRef(false);
  const explicitNew = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const baseline = useRef(JSON.stringify(blank()));
  const dirty = JSON.stringify(draft) !== baseline.current;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  function go(next: number) {
    setStep(next);
    setError(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }

  function load(sprint: Sprint | null, navigate = false) {
    const input = sprint ? structuredClone(sprint.input) : blank();
    currentRef.current = sprint;
    baseline.current = JSON.stringify(input);
    dirtyRef.current = false;
    setCurrent(sprint); setDraft(input); setError(null);
    if (navigate) { go(recommendedStep(sprint)); setEditingSpec(!input.specification); }
    if (sprint) {
      try { localStorage.setItem("agetor.activeSprint", sprint.id); } catch { /* storage can be disabled */ }
    }
  }

  useEffect(() => registerLeaveGuard(() => dirtyRef.current ? { title: "Discard unsaved sprint changes?", description: "Your saved sprint will be preserved." } : null), []);
  useEffect(() => {
    let disposed = false, pending = false;
    const refresh = async () => {
      if (pending || busyRef.current) return;
      pending = true;
      try {
        const result = await api.listSprints();
        if (disposed || busyRef.current) return;
        setSprints(result);
        const previous = currentRef.current;
        const latest = result.find((item) => item.id === previous?.id);
        if (latest && previous && !dirtyRef.current && latest.revision > previous.revision) {
          load(latest);
          if (!previous.input.specification && latest.input.specification) setEditingSpec(false);
        } else if (!previous && !explicitNew.current && !dirtyRef.current && result.length) {
          let lastId: string | null = null;
          try { lastId = localStorage.getItem("agetor.activeSprint"); } catch { /* storage can be disabled */ }
          load(result.find((item) => item.id === lastId) ?? result[0]!, true);
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => { disposed = true; clearInterval(interval); };
  }, []);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, [step]);

  async function choose(sprint: Sprint | null) {
    if (busyRef.current) return;
    if (dirty && !await confirm({ title: "Discard unsaved sprint changes?", confirmLabel: "Discard", variant: "destructive" })) return;
    explicitNew.current = !sprint;
    setNotice("");
    load(sprint, true);
  }

  function receive(sprint: Sprint) {
    load(sprint);
    setSprints((items) => [sprint, ...items.filter((item) => item.id !== sprint.id)]);
    return sprint;
  }
  async function save() {
    const input = validateSprintInput(normalize(draft));
    const target = currentRef.current;
    return receive(target ? await api.editSprint(target.id, target.revision, input) : await api.createSprint(input));
  }

  type Action = "save" | "setup-agents" | "plan" | "approve-spec" | "tickets" | "review" | "approve-batch" | "run" | "pause" | "resume";
  async function act(name: Action) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNotice("");
    try {
      if (name === "run" || name === "pause" || name === "resume") {
        const target = currentRef.current;
        if (!target || (name !== "pause" && dirty)) throw new Error("Save your changes first.");
        receive(await api.sprintAction(target.id, target.revision, name));
        if (name === "run") go(3);
        return;
      }
      const normalized = validateSprintInput(normalize(draft));
      const target = currentRef.current;
      if (name === "approve-batch") {
        const approvedSpec = !!target?.specApproval && target.input.workdir === normalized.workdir && target.input.prompt === normalized.prompt && target.input.specification === normalized.specification;
        const issues = sprintApprovalIssues(normalized, approvedSpec, (id) => !profilesLoaded || profiles.some((profile) => profile.id === id));
        if (issues.length) throw new Error(issues.join(" "));
        const delivery = normalized.shipping.enabled
          ? "Authorize one PR to " + normalized.shipping.repository + ":" + normalized.shipping.base + " and automatic squash merge after verification and green CI."
          : "Keep the verified work on a local branch.";
        if (!await confirm({ title: "Approve this sprint batch?", description: <><p>{normalized.selected.length} tickets: {normalized.selected.join(", ")}.</p><p className="mt-2">{delivery}</p><p className="mt-2">Approval does not start agents. Run starts the approved batch.</p></>, confirmLabel: "Approve exact batch" })) return;
      }
      let saved = await save();
      if (name === "save" || name === "review") {
        setNotice("Draft saved. No agents started.");
        if (name === "review") go(3);
        return;
      }
      if (name === "plan" && (!saved.input.profiles.planner || !profiles.some((profile) => profile.id === saved.input.profiles.planner))) {
        saved = receive(await api.sprintAction(saved.id, saved.revision, "setup-agents"));
        await refreshProfiles();
      }
      receive(await api.sprintAction(saved.id, saved.revision, name));
      if (name === "setup-agents") { await refreshProfiles(); setNotice("Sprint agents ready."); }
      if (name === "plan") { setEditingSpec(false); go(1); }
      if (name === "approve-spec") { go(2); setNotice("Specification approved."); }
      if (name === "approve-batch") setNotice("Batch approved. Run when you’re ready.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  const generation = current?.status === "draft" ? SPRINT_DRAFT_JOBS.find((key) => ["queued", "implementing"].includes(current.state[key]?.status ?? "")) : undefined;
  const generationState = generation ? current?.state[generation] : undefined;
  const executing = !!current && executionStatuses.includes(current.status);
  const editable = !loading && !busy && !generation && !executing && !current?.mergeSha && (!current || ["draft", "paused", "needs_attention"].includes(current.status)) && !Object.values(current?.state ?? {}).some((state) => activeStatuses.includes(state.status));
  const progress = !!current && (executing || current.status === "completed" || (!!current.integrationTaskId && current.status !== "draft"));
  const specApproved = !!current?.specApproval && draft.specification === current.input.specification && draft.prompt === current.input.prompt && draft.workdir.trim() === current.input.workdir;
  const batchApproved = !!current?.batchApproval && !dirty && current.status === "draft";
  const selected = selectedSprintTickets(draft);
  const issues = sprintApprovalIssues(normalize(draft), specApproved, (id) => !profilesLoaded || profiles.some((profile) => profile.id === id));
  if (step === 3) {
    try { validateSprintInput(normalize(draft)); } catch (err) { issues.push(err instanceof Error ? err.message : String(err)); }
  }
  const missingBrief = !draft.name.trim() || !draft.workdir.trim().startsWith("/") || !draft.prompt.trim();
  const stepsDone = [!!current, specApproved, selected.length > 0, batchApproved || current?.status === "completed"];
  const activeError = error || current?.error;
  const canPause = !!generation || executing;
  const canResume = !!current?.integrationTaskId && ["paused", "needs_attention", "waiting_quota"].includes(current.status);

  return <div data-testid="sprints-page" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
    <header className="shrink-0 border-b border-border bg-card">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon" type="button" aria-label="Back to board" onClick={onBack}><ArrowLeft aria-hidden className="size-4" /></Button>
        <h1 className="mr-auto text-base font-semibold">Sprints</h1>
        {current && <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{batchApproved ? "Ready to run" : statusLabel[current.status]}</span>}
        {sprints.length > 0 && <select aria-label="Saved sprint" className={sprintSelect + " max-w-[min(50vw,18rem)]"} value={current?.id ?? ""} disabled={busy} onChange={(event) => { const found = sprints.find((item) => item.id === event.target.value); if (found) void choose(found); }}>
          <option value="" disabled>Choose saved sprint</option>
          {sprints.map((sprint) => <option key={sprint.id} value={sprint.id}>{sprint.input.name}</option>)}
        </select>}
        <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void choose(null)}><Plus aria-hidden className="size-4" />New sprint</Button>
      </div>
      <nav aria-label="Sprint steps" className="mx-auto grid max-w-5xl grid-cols-2 gap-1 px-4 pb-3 sm:grid-cols-4 sm:px-6">
        {steps.map((label, index) => <button type="button" key={label} aria-current={step === index ? "step" : undefined} disabled={busy} onClick={() => go(index)} className={"flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm " + (step === index ? "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/30" : "text-muted-foreground hover:bg-accent")}>
          <span className={"flex size-6 shrink-0 items-center justify-center rounded-full text-xs " + (step === index ? "bg-primary text-primary-foreground" : "bg-muted")}>{stepsDone[index] && step !== index ? <Check aria-hidden className="size-3.5" /> : index + 1}</span>
          {label}
        </button>)}
      </nav>
      {activeError && <div role="alert" className="mx-auto flex max-w-5xl items-start gap-2 border-t border-border px-4 py-3 text-sm text-destructive sm:px-6"><CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /><p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words">{activeError}</p></div>}
      {generation && <div role="status" className="mx-auto flex max-w-5xl items-center gap-2 px-4 pb-3 text-sm text-muted-foreground sm:px-6"><Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />{generationState?.retryAt ? "Waiting for provider quota" : generation === "@plan" ? "Generating specification…" : "Generating tickets…"}<span className="hidden sm:inline"> · Implementation has not started.</span></div>}
    </header>

    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:px-6">
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">{steps[step]}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{[
            "Describe the outcome you want and choose where to work.",
            "Review the scope and decisions before creating tickets.",
            "Choose what to build. Open any ticket to edit its details.",
            progress ? "Track the approved batch and its verification." : "Review the selected work, choose delivery, then approve and run.",
          ][step]}</p>
        </div>

        {loading ? <p role="status" className="text-sm text-muted-foreground">Loading sprints…</p> : <>
          {step === 0 && <fieldset disabled={!editable} className="min-w-0 space-y-4">
            <section className={panel + " space-y-4"}>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block space-y-1 text-sm font-medium">Sprint name<Input aria-label="Sprint name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="block space-y-1 text-sm font-medium">Repository path<Input aria-label="Repository path" value={draft.workdir} onChange={(event) => setDraft({ ...draft, workdir: event.target.value })} placeholder="/absolute/path/to/repository" /></label>
              </div>
              <label className="block space-y-1 text-sm font-medium">Product prompt<textarea aria-label="Product prompt" className={sprintTextarea + " min-h-44 font-normal"} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} placeholder="What should this sprint deliver?" /></label>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={draft.includedOnly} onChange={(event) => setDraft({ ...draft, includedOnly: event.target.checked })} />Use included subscription capacity only; extra spending is disabled.</label>
            </section>
            <SprintDisclosure label="Agent settings">
              <p className="text-sm text-muted-foreground">Defaults: Sonnet plans, Sol writes and reviews tickets, Go DeepSeek builds, Terra handles escalation.</p>
              <div className="grid gap-3 md:grid-cols-2">
                {Object.entries(draft.profiles).map(([role, id]) => <label className="block min-w-0 space-y-1 text-sm" key={role}>{roleLabels[role as keyof typeof roleLabels]}<select aria-label={role + " agent"} className={sprintSelect + " block w-full"} value={id ?? ""} onChange={(event) => setDraft({ ...draft, profiles: { ...draft.profiles, [role]: event.target.value || (role === "escalation" ? null : "") } })}><option value="">Choose agent</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>)}
              </div>
              <Button variant="outline" size="sm" type="button" onClick={() => void act("setup-agents")}>Create missing sprint agents</Button>
            </SprintDisclosure>
          </fieldset>}

          {step === 1 && <section className={panel + " space-y-4"}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="text-sm text-muted-foreground">{specApproved ? "Specification approved" : "Specification awaiting approval"}</span>
              {!!draft.specification && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => setEditingSpec(!editingSpec)}>{editingSpec ? "Preview" : "Edit specification"}</Button>}
            </div>
            {editingSpec || !draft.specification ? <textarea aria-label="Sprint specification" className={sprintTextarea + " min-h-72"} disabled={!editable} value={draft.specification} placeholder="Generate a specification from the brief, or paste your own here." onChange={(event) => setDraft({ ...draft, specification: event.target.value })} /> :
              <div className="agetor-md min-w-0 break-words text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]} components={ASSISTANT_MD_COMPONENTS} urlTransform={MD_URL_TRANSFORM}>{draft.specification}</ReactMarkdown></div>}
            {editable && !!draft.specification && <Button variant="ghost" size="sm" type="button" disabled={missingBrief || !draft.includedOnly} onClick={() => void act("plan")}>Generate a new specification</Button>}
          </section>}

          {step === 2 && <>
            {!specApproved && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm"><p>Approve the specification before generating tickets.</p><Button variant="outline" size="sm" type="button" onClick={() => go(1)}>Review specification</Button></div>}
            <fieldset disabled={!editable} className="min-w-0 space-y-4">
              <SprintTicketsEditor tickets={draft.tickets} selected={draft.selected} onChange={(tickets, selected) => setDraft({ ...draft, tickets, selected })} />
              <SprintChecksEditor checks={draft.checks} onChange={(checks) => setDraft({ ...draft, checks })} />
              {!!draft.tickets.length && <SprintDisclosure label="Ticket generation options"><p className="text-sm text-muted-foreground">Request a new ticket-generation pass only if the approved scope needs more detail.</p><Button size="sm" variant="outline" type="button" disabled={!specApproved} onClick={() => void act("tickets")}>Generate tickets again</Button></SprintDisclosure>}
            </fieldset>
          </>}

          {step === 3 && (progress && current ? <SprintProgress sprint={current} /> : <>
            <section className={panel + " space-y-3"}>
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{selected.length} selected {selected.length === 1 ? "ticket" : "tickets"}</h3><Button variant="ghost" size="sm" type="button" onClick={() => go(2)}>Edit tickets</Button></div>
              <ul className="divide-y divide-border">{selected.map((ticket) => <li key={ticket.key} className="py-2 text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{ticket.key}</span>{ticket.title}</li>)}</ul>
              <p className="text-sm text-muted-foreground">{draft.checks.length} verification {draft.checks.length === 1 ? "command" : "commands"} · independent review · documentation</p>
            </section>
            <fieldset disabled={!editable} className={panel + " min-w-0 space-y-3"}>
              <legend className="px-1 text-sm font-semibold">Delivery</legend>
              <label className="flex items-start gap-2 text-sm"><input className="mt-0.5 accent-primary" type="radio" name="sprint-delivery" checked={!draft.shipping.enabled} onChange={() => setDraft({ ...draft, shipping: { ...draft.shipping, enabled: false } })} />Keep verified work on a local branch</label>
              <label className="flex items-start gap-2 text-sm"><input className="mt-0.5 accent-primary" type="radio" name="sprint-delivery" checked={draft.shipping.enabled} onChange={() => setDraft({ ...draft, shipping: { ...draft.shipping, enabled: true } })} />Open one GitHub PR and merge after green CI</label>
              {draft.shipping.enabled && <div className="space-y-3 border-t border-border pt-3">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
                  <label className="block space-y-1 text-sm">GitHub repository<Input aria-label="Shipping repository" value={draft.shipping.repository} placeholder="owner/repository" onChange={(event) => setDraft({ ...draft, shipping: { ...draft.shipping, repository: event.target.value } })} /></label>
                  <label className="block space-y-1 text-sm">Base branch<Input aria-label="Shipping base" value={draft.shipping.base} onChange={(event) => setDraft({ ...draft, shipping: { ...draft.shipping, base: event.target.value } })} /></label>
                </div>
                <label className="block space-y-1 text-sm">Required CI check names<textarea aria-label="Required CI checks" className={sprintTextarea} value={draft.shipping.requiredChecks.join("\n")} placeholder="One exact check name per line" onChange={(event) => setDraft({ ...draft, shipping: { ...draft.shipping, requiredChecks: event.target.value.split("\n") } })} /></label>
                <p className="text-xs text-muted-foreground">GitHub must enforce up-to-date required checks for administrators on the base branch.</p>
              </div>}
            </fieldset>
            {issues.length ? <section aria-label="Before approval" className={panel + " space-y-2"}><h3 className="text-sm font-semibold">Before approval</h3><ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{[...new Set(issues)].map((issue) => <li key={issue}>{issue}</li>)}</ul>{!specApproved && <Button size="sm" variant="outline" type="button" onClick={() => go(1)}>Review specification</Button>}</section> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Check aria-hidden className="size-4" />{batchApproved ? "Batch approved. Run starts implementation." : "Ready to approve. Approval does not start agents."}</p>}
          </>)}
        </>}
      </div>
    </div>

    <footer className="shrink-0 border-t border-border bg-card">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {editable && <Button variant="outline" size="sm" type="button" onClick={() => void act("save")}>Save draft</Button>}
          {canPause && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void act("pause")}>Pause</Button>}
          <span role="status" className="text-xs text-muted-foreground">{busy ? "Working…" : dirty ? "Unsaved changes" : notice || (current ? "Saved" : "")}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {step > 0 && <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => go(step - 1)}>Previous</Button>}
          {step === 0 && <><Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => go(1)}>Review or write specification</Button><Button size="sm" type="button" disabled={!editable || missingBrief || !draft.includedOnly} onClick={() => void act("plan")}>Generate specification<ArrowRight aria-hidden className="size-4" /></Button></>}
          {step === 1 && (specApproved ? <Button size="sm" type="button" disabled={busy} onClick={() => go(2)}>Review tickets<ArrowRight aria-hidden className="size-4" /></Button> : <Button size="sm" type="button" disabled={!editable || !draft.specification.trim()} onClick={() => void act("approve-spec")}>Approve specification<ArrowRight aria-hidden className="size-4" /></Button>)}
          {step === 2 && (draft.tickets.length ? <Button size="sm" type="button" disabled={!editable || !selected.length} onClick={() => void act("review")}>Review batch<ArrowRight aria-hidden className="size-4" /></Button> : <Button size="sm" type="button" disabled={!editable || !specApproved} onClick={() => void act("tickets")}>Generate tickets<ArrowRight aria-hidden className="size-4" /></Button>)}
          {step === 3 && (progress ? canResume && <Button size="sm" type="button" disabled={busy || dirty} onClick={() => void act("resume")}>Resume sprint</Button> : batchApproved ? <Button size="sm" type="button" disabled={busy} onClick={() => void act("run")}>Run sprint<ArrowRight aria-hidden className="size-4" /></Button> : <Button size="sm" type="button" disabled={!editable || issues.length > 0} onClick={() => void act("approve-batch")}>Approve batch<ArrowRight aria-hidden className="size-4" /></Button>)}
        </div>
      </div>
    </footer>
  </div>;
}
