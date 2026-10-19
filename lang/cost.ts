// Compile-time analysis of query costs: N+1 queries, unbounded result sets, and missing indexes.
// For every screen, component, view, action, API route, export, schedule and channel: the queries
// it runs, each with its SQL, whether it runs once or per row of an enclosing list, and whether
// its result is bounded.
//
// Usage: captured via onQuery hook during generation, then analyzed.
import type { Spec } from "./parser.ts";
import { schemaOf, type Schema } from "./schema.ts";

export type DeepFinding = { severity: "warning"; code: string; line: number; message: string };

export interface QueryInfo {
  entity: string;
  op: string; // "the", "first", "count", "exists", "list", "all"
  line: number;
  col: number;
  sql: string;
  where?: string; // simplified condition for analysis
  limit?: boolean;
  bounded?: boolean; // unique key, count, exists, the, singleton
  perRow?: string; // if in a loop, the entity of the enclosing list
}

let capturedQueries: QueryInfo[] = [];

// Hook called from gen.ts for each compiled query
export function onQuery(q: QueryInfo) {
  capturedQueries.push(q);
}

// Get captured queries and clear for next analysis
export function getQueries(): QueryInfo[] {
  const result = [...capturedQueries];
  capturedQueries = [];
  return result;
}

// Analyze query costs
export function costCheck(spec: Spec): DeepFinding[] {
  const findings: DeepFinding[] = [];
  const warn = (code: string, line: number, message: string) =>
    findings.push({ severity: "warning", code, line, message });

  const queries = getQueries();
  const schema = schemaOf(spec);

  // Identify growing tables (all entities are growing by default)
  const growingTables = new Set<string>();
  for (const name of Object.keys(schema.entities)) {
    if (!schema.entities[name].singleton) {
      growingTables.add(name);
    }
  }

  // Analyze each query
  for (const q of queries) {
    // N+1 detection: query that runs per row of enclosing list
    if (q.perRow && q.op !== "count" && q.op !== "exists") {
      warn(
        "QUERY_PER_ROW",
        q.line,
        `query on ${q.entity} runs once per row of ${q.perRow} (N+1 risk): consider a join or batch`
      );
    }

    // Unbounded detection: query returning rows from a growing table with no limit
    if (q.op === "list" && !q.limit && !q.bounded && growingTables.has(q.entity)) {
      warn(
        "QUERY_UNBOUNDED",
        q.line,
        `query on ${q.entity} returns rows from a growing table with no limit`
      );
    }

    // Unindexed detection: full scan of a growing table
    // For now, warn on any list/all query on a growing table (will refine with actual EXPLAIN)
    if (!q.perRow && q.op === "list" && growingTables.has(q.entity)) {
      warn(
        "QUERY_UNINDEXED",
        q.line,
        `query on ${q.entity} may lack an index: verify with EXPLAIN QUERY PLAN`
      );
    }
  }

  return findings;
}

// Report per-request formulas for screens and views
export function costFormulas(
  spec: Spec,
  queries: QueryInfo[]
): Map<string, string> {
  const formulas = new Map<string, string>();
  const schema = schemaOf(spec);

  // Group queries by their declaration (screen, view, action, etc.)
  const byDecl = new Map<string, QueryInfo[]>();
  for (const q of queries) {
    // For now, just collect them
    // In a real implementation, we'd track which screen/view/action each query comes from
  }

  return formulas;
}
