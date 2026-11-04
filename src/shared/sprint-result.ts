/** Structured final results are intentionally distinct from an agent's exit status. */
import { findHandoffBlocks } from "./handoff-locator.ts";

export function parseSprintResult(segments: string[]): Record<string, unknown> {
  // Reuse the native code-aware scanner, protecting ordinary handoff tags
  // first so quoted pipeline examples cannot become sprint verdicts.
  const normalized = segments.map((segment) => segment.replace(/<(\/?)[hH][aA][nN][dD][oO][fF][fF]\b/g, "<$1quoted-handoff").replaceAll("<sprint-result>", "<handoff>").replaceAll("</sprint-result>", "</handoff>"));
  let offset = 0;
  const segmentStarts = normalized.map((segment) => { const start = offset; offset += segment.length + 1; return start; });
  const text = normalized.join("\n");
  const matches = findHandoffBlocks(text, { segmentStarts });
  if (matches.length !== 1) throw new Error("Expected one explicit sprint result");
  const result: unknown = JSON.parse(text.slice(matches[0]!.openEnd, matches[0]!.closeStart));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid sprint result");
  return result as Record<string, unknown>;
}

export function requireSprintReview(result: Record<string, unknown>, candidate: string): void {
  if (result.verdict !== "PASS" || result.candidate !== candidate || !Array.isArray(result.findings) || result.findings.length !== 0) throw new Error(`Review blocked: ${JSON.stringify(result).slice(0, 4000)}`);
}

export function quotaResetAt(output: string, now: number, failures: number): number | null {
  if (!/quota|rate.?limit|usage.?limit|capacity exhausted|too many requests|credits exhausted/i.test(output)) return null;
  const reset = output.match(/(?:reset|retry)[^\n]{0,30}?(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d))/i);
  const timestamp = reset ? Date.parse(reset[1]!) : NaN;
  if (Number.isFinite(timestamp) && timestamp > now) return timestamp;
  const epoch = output.match(/(?:reset_at|resetsAt|resets_at|reset[_ -]?time)["']?\s*[:=]\s*["']?(\d{10,13})\b/i);
  if (epoch) {
    const at = Number(epoch[1]) * (epoch[1]!.length <= 10 ? 1000 : 1);
    if (at > now) return at;
  }
  const duration = output.match(/(?:reset|retry)[^\n]{0,15}?\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?)/i);
  if (duration) return now + Number(duration[1]) * (/^hour/i.test(duration[2]!) ? 3600_000 : /^minute/i.test(duration[2]!) ? 60_000 : 1000);
  const seconds = output.match(/retry[- _]after["']?\s*[:=]?\s*["']?(\d+)/i);
  if (seconds && Number(seconds[1]) > 0) return Math.min(8_640_000_000_000_000, now + Number(seconds[1]) * 1000);
  return now + Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(failures, 6));
}
