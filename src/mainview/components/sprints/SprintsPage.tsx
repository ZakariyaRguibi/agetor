import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { api } from "@/lib/api";
import { useAgentProfiles } from "@/lib/agent-profiles";
import { registerLeaveGuard } from "@/lib/leave-guard";
import { validateSprintInput, type Sprint, type SprintInput, type SprintTicket, type SprintCheck } from "../../../shared/sprint.ts";

function blank(): SprintInput {
  return { name: "New sprint", workdir: "", prompt: "", specification: "", tickets: [], selected: [], profiles: { planner: "", tickets: "", implementer: "", reviewer: "", escalation: null }, checks: [], shipping: { repository: "", base: "main", requiredChecks: [], enabled: false }, includedOnly: false };
}

/** Native desktop editor. Draft changes never mutate the runner's state. */
export function SprintsPage({ onBack }: { onBack: () => void }) {
  const { profiles, refresh: refreshProfiles } = useAgentProfiles();
  const confirm = useConfirm();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [current, setCurrent] = useState<Sprint | null>(null);
  const [draft, setDraft] = useState<SprintInput>(blank);
  const [ticketText, setTicketText] = useState("[]");
  const [checkText, setCheckText] = useState("[]");
  const [baseline, setBaseline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshot = JSON.stringify([draft, ticketText, checkText]);
  const keyAliases = useRef(new Map<number, string>());
  let ticketRows: SprintTicket[] | null = null;
  try {
    const value: unknown = JSON.parse(ticketText);
    if (Array.isArray(value) && value.every((ticket) => ticket && typeof ticket.key === "string" && typeof ticket.title === "string" && typeof ticket.prompt === "string" && Array.isArray(ticket.acceptance) && ticket.acceptance.every((item: unknown) => typeof item === "string") && Array.isArray(ticket.dependencies) && ticket.dependencies.every((item: unknown) => typeof item === "string"))) ticketRows = value as SprintTicket[];
  } catch { /* raw import remains available for correction */ }
  let checkRows: SprintCheck[] | null = null;
  try {
    const value: unknown = JSON.parse(checkText);
    if (Array.isArray(value) && value.every((check) => check && typeof check.name === "string" && Array.isArray(check.argv) && check.argv.every((item: unknown) => typeof item === "string"))) checkRows = value as SprintCheck[];
  } catch { /* malformed import is shown below */ }
  const updateCheck = (index: number, patch: Partial<SprintCheck>) => { if (checkRows) setCheckText(JSON.stringify(checkRows.map((check, row) => row === index ? { ...check, ...patch } : check), null, 2)); };
  const updateTicket = (index: number, patch: Partial<SprintTicket>) => {
    if (!ticketRows) return;
    const oldKey = ticketRows[index]!.key;
    if (patch.key !== undefined && !keyAliases.current.has(index)) keyAliases.current.set(index, oldKey);
    const referencedKey = keyAliases.current.get(index) ?? oldKey;
    const renamed = patch.key !== undefined && patch.key.trim() !== "";
    const rows = ticketRows.map((ticket, row) => { const updated = row === index ? { ...ticket, ...patch } : ticket; return { ...updated, dependencies: updated.dependencies.map((key) => renamed && key === referencedKey ? patch.key! : key) }; });
    setTicketText(JSON.stringify(rows, null, 2));
    if (renamed) { keyAliases.current.set(index, patch.key!); setDraft({ ...draft, selected: draft.selected.map((key) => key === referencedKey ? patch.key! : key) }); }
  };
  const dirty = baseline !== "" && snapshot !== baseline;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const currentRef = useRef(current); currentRef.current = current;

  function load(sprint: Sprint | null) {
    keyAliases.current.clear();
    const input = sprint ? structuredClone(sprint.input) : blank();
    const tickets = JSON.stringify(input.tickets, null, 2), checks = JSON.stringify(input.checks, null, 2);
    setCurrent(sprint); setDraft(input); setTicketText(tickets); setCheckText(checks);
    setBaseline(JSON.stringify([input, tickets, checks])); setError(null);
  }
  useEffect(() => {
    load(null);
    return registerLeaveGuard(() => dirtyRef.current ? { title: "Discard unsaved sprint changes?", description: "Your saved sprint and execution state will be preserved." } : null);
  }, []);
  useEffect(() => {
    let cancelled = false, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try {
        const result = await api.listSprints();
        if (!cancelled) {
          setSprints(result);
          const active = result.find((item) => item.id === currentRef.current?.id);
          if (active && !dirtyRef.current && active.revision !== currentRef.current?.revision) load(active);
        }
      } catch (e) { if (!cancelled) setError(String(e instanceof Error ? e.message : e)); }
      finally { pending = false; }
    };
    void refresh(); const interval = setInterval(() => void refresh(), 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  async function choose(sprint: Sprint | null) {
    if (dirty && !await confirm({ title: "Discard unsaved sprint changes?", confirmLabel: "Discard", variant: "destructive" })) return;
    load(sprint);
  }
  async function save() {
    const tickets = JSON.parse(ticketText) as SprintTicket[];
    const input = validateSprintInput({ ...draft, tickets: Array.isArray(tickets) ? tickets.map((ticket) => ({ ...ticket, acceptance: Array.isArray(ticket.acceptance) ? ticket.acceptance.map((item) => item.trim()).filter(Boolean) : ticket.acceptance, dependencies: Array.isArray(ticket.dependencies) ? ticket.dependencies.map((item) => item.trim()).filter(Boolean) : ticket.dependencies })) : tickets, checks: checkRows ? checkRows.map((check) => ({ ...check, argv: check.argv.filter((argument) => argument !== "") })) : JSON.parse(checkText) });
    const saved = current ? await api.editSprint(current.id, current.revision, input) : await api.createSprint(input);
    load(saved); setSprints(await api.listSprints()); return saved;
  }
  async function action(name: string) {
    setBusy(true); setError(null);
    try {
      if (name === "approve-batch" && !await confirm({ title: "Approve this sprint batch?", description: "Approve the selected tickets, dependencies, agents and checks. If shipping is enabled, this also authorizes pushing, one PR and merging after final verification and green CI. No extra paid usage is allowed.", confirmLabel: "Approve exact batch" })) return;
      const saved = name === "pause" && current ? current : dirty || !current ? await save() : current;
      if (name !== "save") load(await api.sprintAction(saved.id, saved.revision, name));
      if (name === "setup-agents") await refreshProfiles();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const active = !!current && Object.values(current.state).some((state) => ["implementing", "reviewing", "checking"].includes(state.status));
  const editable = !active && (!current || ["draft", "paused", "needs_attention"].includes(current.status));
  const textarea = "min-h-28 w-full rounded-md border border-input bg-background p-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
  return (
    <div data-testid="sprints-page" className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card p-3">
        <Button variant="ghost" size="sm" onClick={onBack}>Back</Button>
        <h1 className="flex-1 text-sm font-semibold">Sprints</h1>
        <Button size="sm" variant="outline" onClick={() => void choose(null)}>New sprint</Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Saved sprints" className="w-48 shrink-0 overflow-y-auto border-r border-border p-2">
          {sprints.length === 0 && <p className="p-2 text-xs text-muted-foreground">No saved sprints yet.</p>}
          {sprints.map((sprint) => <button type="button" key={sprint.id} onClick={() => void choose(sprint)} aria-current={current?.id === sprint.id ? "page" : undefined} className="mb-1 block w-full rounded-md border border-border p-2 text-left text-xs hover:bg-accent"><span className="block font-medium">{sprint.input.name}</span><span className="text-muted-foreground">{sprint.status} · revision {sprint.revision}</span></button>)}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
          {current?.error && <p role="status" className="mb-3 text-sm text-warning">{current.error}</p>}
          <fieldset disabled={busy || !editable} className="space-y-4 disabled:opacity-70">
            <label className="block text-xs">Sprint name<Input aria-label="Sprint name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="block text-xs">Repository path<Input aria-label="Repository path" value={draft.workdir} onChange={(e) => setDraft({ ...draft, workdir: e.target.value })} placeholder="/absolute/path/to/repository" /></label>
            <label className="block text-xs">Product prompt<textarea aria-label="Product prompt" className={textarea} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label>
            <label className="block text-xs">Specification (Markdown)<textarea aria-label="Sprint specification" className={textarea} value={draft.specification} onChange={(e) => setDraft({ ...draft, specification: e.target.value })} /></label>
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(draft.profiles).map(([role, value]) => <label key={role} className="block text-xs capitalize">{role}<select aria-label={`${role} agent`} className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={value ?? ""} onChange={(e) => setDraft({ ...draft, profiles: { ...draft.profiles, [role]: e.target.value || (role === "escalation" ? null : "") } })}><option value="">Choose agent</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>)}
            </div>
            <Button size="sm" variant="outline" onClick={() => void action("setup-agents")}>Create missing sprint agents</Button>
            <section aria-label="Sprint backlog" className="space-y-3">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Backlog</h2><Button variant="outline" size="sm" disabled={!ticketRows} onClick={() => {
                const rows = ticketRows ?? []; let n = rows.length + 1; while (rows.some((ticket) => ticket.key === `T-${n}`)) n += 1;
                setTicketText(JSON.stringify([...rows, { key: `T-${n}`, title: "", prompt: "", acceptance: [], dependencies: [] }], null, 2));
              }}>Add ticket</Button></div>
              {ticketRows?.length === 0 && <p className="text-xs text-muted-foreground">Generate tickets from your approved specification, or add one here.</p>}
              {ticketRows?.map((ticket, index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2"><label className="flex items-center gap-2 text-xs"><input aria-label={`Include ${ticket.key} in sprint`} type="checkbox" checked={draft.selected.includes(ticket.key)} onChange={(e) => setDraft({ ...draft, selected: e.target.checked ? [...new Set([...draft.selected, ticket.key])] : draft.selected.filter((key) => key !== ticket.key) })} />Include in this sprint</label><span className="ml-auto text-xs text-muted-foreground">{current?.state[ticket.key]?.status ?? "backlog"}</span></div>
                <div className="grid gap-2 sm:grid-cols-[120px_1fr]"><label className="text-xs">Ticket key<Input aria-label={`Ticket ${index + 1} key`} value={ticket.key} onChange={(e) => updateTicket(index, { key: e.target.value })} /></label><label className="text-xs">Title<Input aria-label={`Ticket ${index + 1} title`} value={ticket.title} onChange={(e) => updateTicket(index, { title: e.target.value })} /></label></div>
                <label className="block text-xs">Implementation instructions<textarea aria-label={`Ticket ${index + 1} instructions`} className={textarea} value={ticket.prompt} onChange={(e) => updateTicket(index, { prompt: e.target.value })} /></label>
                <label className="block text-xs">Acceptance criteria (one per line)<textarea aria-label={`Ticket ${index + 1} acceptance criteria`} className={textarea} value={ticket.acceptance.join("\n")} onChange={(e) => updateTicket(index, { acceptance: e.target.value.split("\n") })} /></label>
                <label className="block text-xs">Prerequisite ticket keys (comma separated)<Input aria-label={`Ticket ${index + 1} prerequisites`} value={ticket.dependencies.join(", ")} onChange={(e) => updateTicket(index, { dependencies: e.target.value.split(",").map((key) => key.trim()) })} /></label>
              </div>)}
              <details><summary className="cursor-pointer text-xs text-muted-foreground">Import or edit ticket JSON</summary><textarea aria-label="Sprint tickets" className={`${textarea} mt-2 font-mono text-xs`} value={ticketText} onChange={(e) => { keyAliases.current.clear(); setTicketText(e.target.value); }} /></details>
              {!ticketRows && <p role="alert" className="text-xs text-danger">The ticket import is invalid. Correct its JSON before saving.</p>}
            </section>
            <section aria-label="Verification commands" className="space-y-3">
              <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">Verification commands</h2><Button size="sm" variant="outline" disabled={!checkRows} onClick={() => setCheckText(JSON.stringify([...(checkRows ?? []), { name: "", argv: [""] }], null, 2))}>Add command</Button></div>
              <p className="text-xs text-muted-foreground">Commands run directly in each worktree. Put each argument on its own line; shell expansion is not applied.</p>
              {checkRows?.map((check, index) => <div key={index} className="space-y-2 rounded-lg border border-border p-3">
                <label className="block text-xs">Check name<Input aria-label={`Check ${index + 1} name`} value={check.name} onChange={(e) => updateCheck(index, { name: e.target.value })} /></label>
                <label className="block text-xs">Program<Input aria-label={`Check ${index + 1} program`} value={check.argv[0] ?? ""} onChange={(e) => updateCheck(index, { argv: [e.target.value, ...check.argv.slice(1)] })} placeholder="corepack" /></label>
                <label className="block text-xs">Arguments (one per line)<textarea aria-label={`Check ${index + 1} arguments`} className={textarea} value={check.argv.slice(1).join("\n")} onChange={(e) => updateCheck(index, { argv: [check.argv[0] ?? "", ...(e.target.value === "" ? [] : e.target.value.split("\n"))] })} placeholder={'pnpm\ntest'} /></label>
                <Button size="sm" variant="ghost" onClick={() => setCheckText(JSON.stringify(checkRows!.filter((_, row) => row !== index), null, 2))}>Remove command</Button>
              </div>)}
              <details><summary className="cursor-pointer text-xs text-muted-foreground">Import or edit command JSON</summary><textarea aria-label="Sprint checks" className={`${textarea} mt-2 font-mono text-xs`} value={checkText} onChange={(e) => setCheckText(e.target.value)} /></details>
              {!checkRows && <p role="alert" className="text-xs text-danger">Correct the command import before saving.</p>}
            </section>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.includedOnly} onChange={(e) => setDraft({ ...draft, includedOnly: e.target.checked })} />Use included subscription capacity only; extra spending is disabled.</label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.shipping.enabled} onChange={(e) => setDraft({ ...draft, shipping: { ...draft.shipping, enabled: e.target.checked } })} />Authorize automatic shipping when the exact batch is approved.</label>
            <label className="block text-xs">GitHub repository<Input aria-label="Shipping repository" value={draft.shipping.repository} onChange={(e) => setDraft({ ...draft, shipping: { ...draft.shipping, repository: e.target.value } })} placeholder="owner/repository" /></label>
            <label className="block text-xs">Base branch<Input aria-label="Shipping base" value={draft.shipping.base} onChange={(e) => setDraft({ ...draft, shipping: { ...draft.shipping, base: e.target.value } })} /></label>
            <label className="block text-xs">Required CI check names (one per line)<textarea aria-label="Required CI checks" className={textarea} value={draft.shipping.requiredChecks.join("\n")} onChange={(e) => setDraft({ ...draft, shipping: { ...draft.shipping, requiredChecks: e.target.value.split("\n").filter(Boolean) } })} /></label>
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy || !editable} onClick={() => void action("save")}>{busy ? "Working…" : "Save draft"}</Button>
            <Button variant="outline" disabled={busy || !editable} onClick={() => void action("approve-spec")}>Approve specification</Button>
            <Button variant="outline" disabled={busy || !editable} onClick={() => void action("approve-batch")}>Approve batch</Button>
            <Button variant="outline" disabled={busy || !editable} onClick={() => void action("plan")}>Generate specification</Button>
            <Button variant="outline" disabled={busy || !editable || !current?.specApproval} onClick={() => void action("tickets")}>Generate tickets</Button>
            <Button disabled={busy || dirty || !current?.batchApproval || current.status !== "draft"} onClick={() => void action("run")}>Run sprint</Button>
            <Button variant="outline" disabled={busy || !current || current.status === "paused" || current.status === "completed"} onClick={() => void action("pause")}>Pause</Button>
            <Button variant="outline" disabled={busy || !current || !["paused", "needs_attention", "waiting_quota"].includes(current.status)} onClick={() => void action("resume")}>Resume</Button>
          </div>
          {current && <section aria-label="Execution evidence" className="mt-4 space-y-2">
            {Object.entries(current.state).filter(([key, state]) => key.startsWith("@") || state.checks.length > 0).map(([key, state]) => <details key={key} className="rounded-md border border-border p-3 text-xs">
              <summary className="cursor-pointer font-medium">{key === "@docs" ? "Documentation" : key === "@final" ? "Whole-sprint verification" : key.startsWith("@final-review") ? "Final independent review" : key} · {state.status} · {state.repairs}/3 repairs</summary>
              {state.candidate && <p className="mt-2 break-all text-muted-foreground">Candidate {state.candidate} · {state.reviewed === state.candidate ? "reviewed" : "awaiting matching review"}</p>}
              {state.retryAt && <p className="mt-2 text-muted-foreground">Retry after {new Date(state.retryAt).toLocaleString()}</p>}
              {state.error && <p className="mt-2 whitespace-pre-wrap text-warning">{state.error}</p>}
              {state.checks.map((check, index) => <div key={index} className="mt-3"><p>{check.name} · exit {check.exitCode}</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{check.output || "No command output."}</pre></div>)}
            </details>)}
          </section>}
          {current && <div className="mt-4 space-y-2"><p role="status" className="text-xs text-muted-foreground">{current.status} · specification {current.specApproval ? "approved" : "awaiting approval"} · batch {current.batchApproval ? "approved" : "awaiting approval"}</p>{current.prUrl && <a className="text-xs underline" href={current.prUrl} target="_blank" rel="noreferrer">Sprint pull request</a>}{current.input.tickets.map((ticket) => <div key={ticket.key} className="rounded-md border border-border p-2 text-xs"><strong>{ticket.key}: {ticket.title}</strong><p className="text-muted-foreground">Depends on {ticket.dependencies.join(", ") || "none"} · {current.state[ticket.key]?.status ?? "queued"} · {current.state[ticket.key]?.repairs ?? 0}/3 repair rounds</p>{current.state[ticket.key]?.error && <p className="mt-1 text-warning">{current.state[ticket.key]!.error}</p>}</div>)}</div>}
        </div>
      </div>
    </div>
  );
}
