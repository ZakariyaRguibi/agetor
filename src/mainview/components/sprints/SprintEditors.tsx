import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SprintCheck, SprintTicket } from "../../../shared/sprint.ts";

export const sprintTextarea = "min-h-24 w-full resize-y rounded-lg border border-input bg-background p-3 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
export const sprintSelect = "h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SprintDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className="group rounded-lg border border-border bg-card">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      {label}<ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
    <div className="space-y-3 border-t border-border p-4">{children}</div>
  </details>;
}

function JsonImport<T>({ label, rows, validate, onApply }: { label: string; rows: T[]; validate: (value: unknown) => value is T[]; onApply: (rows: T[]) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  function apply() {
    try {
      const value: unknown = JSON.parse(text ?? JSON.stringify(rows));
      if (!validate(value)) throw new Error("Check the JSON structure and field types.");
      onApply(value);
      setText(null);
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  return <SprintDisclosure label={label}>
    <textarea aria-label={label} className={sprintTextarea + " font-mono text-xs"} value={text ?? JSON.stringify(rows, null, 2)} onChange={(event) => setText(event.target.value)} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button size="sm" variant="outline" type="button" onClick={apply}>Apply JSON</Button>
  </SprintDisclosure>;
}

function ticketArray(value: unknown): value is SprintTicket[] {
  return Array.isArray(value) && value.every((item) => item && typeof item.key === "string" && typeof item.title === "string" && typeof item.prompt === "string" && Array.isArray(item.acceptance) && item.acceptance.every((entry: unknown) => typeof entry === "string") && Array.isArray(item.dependencies) && item.dependencies.every((entry: unknown) => typeof entry === "string"));
}
function checkArray(value: unknown): value is SprintCheck[] {
  return Array.isArray(value) && value.every((item) => item && typeof item.name === "string" && Array.isArray(item.argv) && item.argv.every((entry: unknown) => typeof entry === "string"));
}

function changeSelection(tickets: SprintTicket[], selected: string[], key: string, include: boolean): string[] {
  const next = new Set(selected);
  if (include) {
    const visited = new Set<string>();
    const add = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const ticket = tickets.find((row) => row.key === id);
      if (!ticket) return;
      next.add(id);
      ticket.dependencies.map((dependency) => dependency.trim()).forEach(add);
    };
    add(key);
  } else {
    next.delete(key);
    // An excluded prerequisite must also exclude every dependent.
    let changed = true;
    while (changed) {
      changed = false;
      for (const ticket of tickets) if (next.has(ticket.key) && ticket.dependencies.some((dependency) => dependency.trim() && !next.has(dependency.trim()))) {
        next.delete(ticket.key);
        changed = true;
      }
    }
  }
  return tickets.map((ticket) => ticket.key).filter((id) => next.has(id));
}

export function SprintTicketsEditor({ tickets, selected, onChange }: { tickets: SprintTicket[]; selected: string[]; onChange: (tickets: SprintTicket[], selected: string[]) => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const aliases = useRef(new Map<number, string>());
  function update(index: number, patch: Partial<SprintTicket>) {
    const oldKey = tickets[index]!.key || aliases.current.get(index) || "";
    if (oldKey) aliases.current.set(index, oldKey);
    const newKey = patch.key?.trim();
    onChange(tickets.map((ticket, row) => {
      const changed = row === index ? { ...ticket, ...patch } : ticket;
      return { ...changed, dependencies: changed.dependencies.map((key) => newKey && key.trim() === oldKey ? newKey : key) };
    }), newKey ? selected.map((key) => key === oldKey ? newKey : key) : selected);
  }
  function add() {
    let number = tickets.length + 1;
    while (tickets.some((ticket) => ticket.key === "T-" + number)) number++;
    setExpanded(tickets.length);
    onChange([...tickets, { key: "T-" + number, title: "", prompt: "", acceptance: [], dependencies: [] }], selected);
  }
  function remove(index: number) {
    const key = tickets[index]!.key;
    onChange(tickets.filter((_, row) => row !== index), selected.filter((id) => id !== key));
    aliases.current.clear();
    setExpanded(null);
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{selected.length} of {tickets.length} selected. Selecting a ticket includes its prerequisites.</p>
      <div className="flex flex-wrap gap-2">
        {tickets.length > 0 && <Button size="sm" variant="ghost" type="button" onClick={() => onChange(tickets, selected.length === tickets.length ? [] : tickets.map((ticket) => ticket.key))}>{selected.length === tickets.length ? "Clear selection" : "Select all"}</Button>}
        <Button size="sm" variant="outline" type="button" onClick={add}><Plus aria-hidden className="size-4" />Add ticket</Button>
      </div>
    </div>
    {tickets.length === 0 && <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">Generate tickets from the approved specification, or add a ticket yourself.</p>}
    {tickets.map((ticket, index) => {
      const label = "Ticket " + (index + 1);
      const open = expanded === index;
      const hasDependent = tickets.some((other) => other.dependencies.includes(ticket.key));
      return <article key={index} className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 px-3 py-2">
          <input aria-label={"Include " + ticket.key + " in sprint"} className="size-4 shrink-0 accent-primary" type="checkbox" checked={selected.includes(ticket.key)} onChange={(event) => onChange(tickets, changeSelection(tickets, selected, ticket.key, event.target.checked))} />
          <button type="button" aria-expanded={open} aria-label={label + ": " + (ticket.title || "Untitled ticket")} onClick={() => setExpanded(open ? null : index)} className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md p-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="min-w-0">
              <span className="block break-words text-sm font-medium"><span className="mr-2 font-mono text-xs text-muted-foreground">{ticket.key}</span>{ticket.title || "Untitled ticket"}</span>
              {ticket.dependencies.some(Boolean) && <span className="block break-words text-xs text-muted-foreground">After {ticket.dependencies.filter(Boolean).join(", ")}</span>}
            </span>
            <ChevronDown aria-hidden className={"size-4 shrink-0 text-muted-foreground " + (open ? "rotate-180" : "")} />
          </button>
        </div>
        {open && <div className="space-y-3 border-t border-border p-4">
          <div className="grid gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <label className="block space-y-1 text-sm">Key<Input aria-label={label + " key"} value={ticket.key} onChange={(event) => update(index, { key: event.target.value })} /></label>
            <label className="block space-y-1 text-sm">Title<Input aria-label={label + " title"} value={ticket.title} onChange={(event) => update(index, { title: event.target.value })} /></label>
          </div>
          <label className="block space-y-1 text-sm">Implementation instructions<textarea aria-label={label + " instructions"} className={sprintTextarea} value={ticket.prompt} onChange={(event) => update(index, { prompt: event.target.value })} /></label>
          <label className="block space-y-1 text-sm">Acceptance criteria <span className="text-muted-foreground">(one per line)</span><textarea aria-label={label + " acceptance criteria"} className={sprintTextarea} value={ticket.acceptance.join("\n")} onChange={(event) => update(index, { acceptance: event.target.value.split("\n") })} /></label>
          <label className="block space-y-1 text-sm">Prerequisites <span className="text-muted-foreground">(comma separated)</span><Input aria-label={label + " prerequisites"} value={ticket.dependencies.join(",")} onChange={(event) => update(index, { dependencies: event.target.value.split(",") })} /></label>
          <Button size="sm" variant="ghost" type="button" disabled={hasDependent} title={hasDependent ? "Remove this prerequisite from its dependents first" : undefined} onClick={() => remove(index)}>Remove ticket</Button>
        </div>}
      </article>;
    })}
    <JsonImport label="Advanced: ticket JSON" rows={tickets} validate={ticketArray} onApply={(rows) => { aliases.current.clear(); setExpanded(null); onChange(rows, selected.filter((key) => rows.some((row) => row.key === key))); }} />
  </div>;
}

export function SprintChecksEditor({ checks, onChange }: { checks: SprintCheck[]; onChange: (checks: SprintCheck[]) => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const update = (index: number, patch: Partial<SprintCheck>) => onChange(checks.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  return <SprintDisclosure label={"Verification commands · " + checks.length}>
    <p className="text-sm text-muted-foreground">These run locally in each worktree. Use one argument per line. Put CI-only setup in your CI workflow.</p>
    {checks.map((check, index) => {
      const label = "Check " + (index + 1);
      return <div key={index} className="rounded-lg border border-border p-3">
        <button type="button" aria-expanded={expanded === index} className="w-full rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setExpanded(expanded === index ? null : index)}>
          <span className="block text-sm font-medium">{check.name || "Untitled command"}</span>
          <span className="block break-all font-mono text-xs text-muted-foreground">{check.argv.filter(Boolean).join(" ") || "No program"}</span>
        </button>
        {expanded === index && <div className="mt-3 space-y-2">
          <label className="block space-y-1 text-sm">Name<Input aria-label={label + " name"} value={check.name} onChange={(event) => update(index, { name: event.target.value })} /></label>
          <label className="block space-y-1 text-sm">Program<Input aria-label={label + " program"} value={check.argv[0] ?? ""} onChange={(event) => update(index, { argv: [event.target.value, ...check.argv.slice(1)] })} placeholder="corepack" /></label>
          <label className="block space-y-1 text-sm">Arguments<textarea aria-label={label + " arguments"} className={sprintTextarea} value={check.argv.slice(1).join("\n")} onChange={(event) => update(index, { argv: [check.argv[0] ?? "", ...event.target.value.split("\n")] })} /></label>
          <Button size="sm" variant="ghost" type="button" onClick={() => { onChange(checks.filter((_, row) => row !== index)); setExpanded(null); }}>Remove command</Button>
        </div>}
      </div>;
    })}
    <Button size="sm" variant="outline" type="button" onClick={() => { setExpanded(checks.length); onChange([...checks, { name: "", argv: [""] }]); }}><Plus aria-hidden className="size-4" />Add command</Button>
    <JsonImport label="Advanced: command JSON" rows={checks} validate={checkArray} onApply={(rows) => { setExpanded(null); onChange(rows); }} />
  </SprintDisclosure>;
}
