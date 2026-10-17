// The Phase 1 checker: static checks, then bounded exploration with the reference interpreter.
import type { Spec } from "../ast.ts";
import type { Finding } from "./finding.ts";
import { StaticChecker } from "./static.ts";
import { Explorer, type Scope } from "./explore.ts";

export type CheckResult = { findings: Finding[]; errors: number; warnings: number; stats: Record<string, number> };

export function check(spec: Spec, scope: Scope): CheckResult {
  const findings = new StaticChecker(spec).run();
  const stats: Record<string, number> = {};
  // Exploration runs only on a spec that resolves; a static error would make it misleading.
  if (!findings.some((f) => f.severity === "error")) {
    const ex = new Explorer(spec, scope);
    findings.push(...ex.run());
    stats.runs = ex.runs;
    stats.states = ex.nodes.size;
  }
  return { findings, errors: findings.filter((f) => f.severity === "error").length, warnings: findings.filter((f) => f.severity === "warning").length, stats };
}
