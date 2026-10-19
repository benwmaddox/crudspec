// Compile-time analysis of query costs with evidence-based warnings.
// Captures queries during generation with their context (declaration, per-row loops),
// analyzes them with EXPLAIN QUERY PLAN to find actual unindexed scans, and detects
// N+1 patterns from the context.
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { Spec } from "./parser.ts";
import { schemaOf, type Schema } from "./schema.ts";

export type DeepFinding = { severity: "warning"; code: string; line: number; message: string };

export interface QueryInfo {
  entity: string;
  op: string; // "the", "the_or_none", "first_or_none", "count", "exists", "list", "all"
  line: number;
  col: number;
  sql: string;
  where?: string;
  limit?: boolean;
  bounded?: boolean; // unique key, count, exists, the, singleton
  decl?: string; // screen/component/view/action/API/export/schedule/channel name
  perRowLoop?: Array<{ entity: string; source: string }>; // enclosing per-row loops: which entity, from what source
}

let capturedQueries: QueryInfo[] = [];

// Hook called from gen.ts for each compiled query
export function onQuery(q: QueryInfo) {
  capturedQueries.push(q);
}

// Track context as gen.ts generates declarations
export let currentDecl: string | undefined;
export let loopStack: Array<{ entity: string; source: string }> = [];

export function pushDecl(name: string) {
  currentDecl = name;
}

export function popDecl() {
  currentDecl = undefined;
}

export function pushLoop(entity: string, source: string) {
  loopStack.push({ entity, source });
}

export function popLoop() {
  loopStack.pop();
}

// Get captured queries and clear for next analysis
export function getQueries(): QueryInfo[] {
  const result = [...capturedQueries];
  capturedQueries = [];
  loopStack = [];
  return result;
}

// Run EXPLAIN QUERY PLAN on a query against the spec's schema
function explainQuery(
  db: DatabaseSync,
  sql: string,
  schema: Schema
): { scan?: string; columns?: string[] } | null {
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as any[];

    // Look for SCAN of entity tables (not system tables or searches with indexes)
    for (const row of plan) {
      const detail = row.detail || "";

      // Pattern: "SCAN TABLE X" or "SCAN X" means full table scan without an index
      const scanMatch = detail.match(
        /SCAN\s+(?:TABLE\s+)?(?:\")?([A-Za-z_]\w*)(?:\")?(?:\s|$)/
      );
      if (scanMatch) {
        const tableName = scanMatch[1];
        // Only warn for entity tables that grow (not singletons)
        if (
          schema.entities[tableName] &&
          !schema.entities[tableName].singleton
        ) {
          return { scan: tableName, columns: [] };
        }
      }

      // Pattern: "SEARCH TABLE X USING INDEX" means indexed, so it's fine
      if (detail.includes("USING INDEX") || detail.includes("PRIMARY KEY")) {
        return null; // indexed, not a problem
      }
    }

    return null;
  } catch (e) {
    // Invalid SQL or other error - can't analyze
    return null;
  }
}

// Build a minimal schema in SQLite for EXPLAIN analysis
function buildSchemaInDb(db: DatabaseSync, schema: Schema) {
  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

  for (const [name, entity] of Object.entries(schema.entities)) {
    const cols: string[] = [];

    for (const [fieldName, field] of Object.entries(entity.fields)) {
      const type = field.type === "Int"
        ? "INTEGER"
        : field.type === "Bool"
          ? "INTEGER"
          : field.type === "Time"
            ? "INTEGER"
            : "TEXT";
      cols.push(`, ${q(fieldName)} ${type}${field.optional ? "" : " NOT NULL"}`);
    }

    db.exec(
      `CREATE TABLE IF NOT EXISTS ${q(name)} (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL${cols.join("")}) STRICT`
    );

    // Create the indexes that are explicitly declared
    for (const idx of entity.indexes ?? []) {
      const idxName = `idx_${name}_${idx.join("_")}`;
      try {
        db.exec(
          `CREATE INDEX IF NOT EXISTS ${q(idxName)} ON ${q(name)}(${idx.map((f) => q(f)).join(", ")})`
        );
      } catch {
        // Index might conflict, skip
      }
    }
  }
}

// Analyze queries for cost issues
export function costCheck(spec: Spec): DeepFinding[] {
  const findings: DeepFinding[] = [];
  const warn = (code: string, line: number, message: string) =>
    findings.push({ severity: "warning", code, line, message });

  const queries = getQueries();
  if (queries.length === 0) return findings;

  const schema = schemaOf(spec);

  // Set up temporary database for EXPLAIN analysis
  const tmpDir = mkdtempSync(join(tmpdir(), "crudspec-cost-"));
  const dbPath = join(tmpDir, ":memory:");

  try {
    const db = new DatabaseSync(":memory:");
    buildSchemaInDb(db, schema);

    // Analyze each query
    const growingEntities = new Set<string>();
    for (const [name, entity] of Object.entries(schema.entities)) {
      if (!entity.singleton) growingEntities.add(name);
    }

    for (const q of queries) {
      // N+1 detection: query runs per row of an enclosing loop
      if (
        q.perRowLoop &&
        q.perRowLoop.length > 0 &&
        q.op !== "count" &&
        q.op !== "exists"
      ) {
        const loops = q.perRowLoop
          .map(
            (l) =>
              `${l.entity} (from ${l.source === "all" ? "all rows" : l.source})`
          )
          .join(", ");
        warn(
          "QUERY_PER_ROW",
          q.line,
          `query on ${q.entity} runs once per row of ${loops} (N+1 pattern); consider batching or prefetching`
        );
      }

      // QUERY_UNBOUNDED: list query on growing table with no limit
      if (
        q.op === "list" &&
        !q.limit &&
        !q.bounded &&
        growingEntities.has(q.entity)
      ) {
        warn(
          "QUERY_UNBOUNDED",
          q.line,
          `query on ${q.entity} returns unbounded rows from a growing table; add a limit`
        );
      }

      // QUERY_UNINDEXED: EXPLAIN shows a full scan of a growing table
      if (growingEntities.has(q.entity) && q.sql) {
        const scanInfo = explainQuery(db, q.sql, schema);
        if (scanInfo && scanInfo.scan) {
          warn(
            "QUERY_UNINDEXED",
            q.line,
            `query on ${q.entity} performs a full table scan (EXPLAIN: SCAN ${scanInfo.scan}); add an index on the filter/join fields`
          );
        }
      }
    }

    db.close();
  } finally {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // best effort
    }
  }

  return findings;
}

// Report per-request cost formulas
export function costFormulas(
  spec: Spec,
  queries: QueryInfo[]
): Map<string, string> {
  const formulas = new Map<string, string>();

  // Group queries by declaration
  const byDecl = new Map<string, QueryInfo[]>();
  for (const q of queries) {
    if (!q.decl) continue;
    if (!byDecl.has(q.decl)) byDecl.set(q.decl, []);
    byDecl.get(q.decl)!.push(q);
  }

  // Build formulas for each declaration
  for (const [decl, qs] of byDecl) {
    const parts: string[] = [];
    const perRow = new Map<string, number>();

    for (const q of qs) {
      if (!q.perRowLoop || q.perRowLoop.length === 0) {
        parts.push("1");
      } else {
        const source = q.perRowLoop[0]?.source ?? "rows";
        perRow.set(source, (perRow.get(source) ?? 0) + 1);
      }
    }

    let formula = parts.length > 0 ? `${parts.length} query` : "";
    for (const [source, count] of perRow) {
      if (formula) formula += " + ";
      formula += `${count} per ${source}`;
    }

    if (formula) formulas.set(decl, formula);
  }

  return formulas;
}
