// Compile-time analysis of query costs: N+1 queries, unbounded result sets, and missing indexes.
// For every screen, component, view, action, API route, export, schedule and channel: the queries
// it runs, each with its SQL, whether it runs once or per row of an enclosing list, and whether
// its result is bounded.
//
// Usage: captured via onQuery hook during generation, then analyzed.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Spec } from "./parser.ts";
import { schemaOf, type Schema } from "./schema.ts";
import { upgrade } from "./runtime/upgrade.ts";

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

// Check which tables and fields have indexes using EXPLAIN QUERY PLAN
export function checkIndexes(
  spec: Spec,
  queries: QueryInfo[]
): Map<string, Set<string>> {
  const schema = schemaOf(spec);
  const indexed = new Map<string, Set<string>>();

  // Create a temporary in-memory database with the schema
  const tmpDir = mkdtempSync(join(tmpdir(), "crudspec-cost-"));
  const dbPath = join(tmpDir, "check.db");

  try {
    const db = new DatabaseSync(dbPath);

    // Create schema (same as store-sqlite.ts does)
    createSchema(db, schema);

    // Check each query's execution plan
    for (const q of queries) {
      try {
        const plan = db
          .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
          .all() as any[];

        // Parse EXPLAIN output for index usage
        for (const row of plan) {
          const detail = row.detail || "";

          // Indexed if:
          // - uses an index: "SEARCH ... USING INDEX"
          // - integer primary key: "INTEGER PRIMARY KEY"
          // - exact match or ordered full scan: "SCAN ... USING INDEX"
          if (detail.includes("USING INDEX")) {
            const match = detail.match(
              /(?:SCAN|SEARCH)\s+(?:TABLE\s+)?"?(\w+)"?/
            );
            if (match) {
              const table = match[1];
              if (!indexed.has(table)) indexed.set(table, new Set());
              indexed.get(table)!.add("*"); // Mark that table has some index
            }
          }

          // Track specific field usage if we can parse it
          // "SCAN TABLE Entity USING INTEGER PRIMARY KEY" means id is indexed
          if (detail.includes("INTEGER PRIMARY KEY")) {
            const match = detail.match(/SCAN\s+(?:TABLE\s+)?"?(\w+)"?/);
            if (match) {
              const table = match[1];
              if (!indexed.has(table)) indexed.set(table, new Set());
              indexed.get(table)!.add("id");
            }
          }
        }
      } catch {
        // Query might not be valid SQL for explain, skip
      }
    }

    db.close();
    return indexed;
  } finally {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // cleanup best effort
    }
  }
}

// Create schema in SQLite for EXPLAIN analysis
function createSchema(db: DatabaseSync, schema: Schema) {
  const q = (n: string) => `"${n.replace(/"/g, '""')}"`;

  for (const [name, entity] of Object.entries(schema.entities)) {
    const cols: string[] = [];
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      const type = fieldType(field.type);
      cols.push(`, ${q(fieldName)} ${type}${field.optional ? "" : " NOT NULL"}`);
    }

    db.exec(
      `CREATE TABLE IF NOT EXISTS ${q(name)} (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL${cols.join("")}) STRICT`
    );

    // Add reference field indexes (these are what we want to check)
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      if (field.ref) {
        const idxName = `idx_${name}_${fieldName}`;
        try {
          db.exec(
            `CREATE INDEX IF NOT EXISTS ${q(idxName)} ON ${q(name)}(${q(fieldName)})`
          );
        } catch {
          // Index might already exist
        }
      }
    }
  }
}

function fieldType(type: string): string {
  if (type === "Int") return "INTEGER";
  if (type === "Bool") return "INTEGER";
  if (type === "Time") return "INTEGER";
  if (type.startsWith("set of") || type.startsWith("list of"))
    return "TEXT";
  return "TEXT"; // Default for text, email, url, ip, ref, enum, json, etc.
}

export function costCheck(spec: Spec): DeepFinding[] {
  const findings: DeepFinding[] = [];
  const warn = (code: string, line: number, message: string) =>
    findings.push({ severity: "warning", code, line, message });

  const queries = getQueries();
  const indexed = checkIndexes(spec, queries);
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
    if (
      q.op === "list" &&
      !q.limit &&
      !q.bounded &&
      growingTables.has(q.entity)
    ) {
      warn(
        "QUERY_UNBOUNDED",
        q.line,
        `query on ${q.entity} returns rows from a growing table with no limit`
      );
    }

    // Unindexed detection: full scan of a growing table for a per-request query
    if (
      !q.perRow &&
      growingTables.has(q.entity) &&
      q.op !== "the" &&
      q.op !== "count" &&
      q.op !== "exists"
    ) {
      const tableHasIndex =
        indexed.has(q.entity) && indexed.get(q.entity)!.size > 0;
      if (!tableHasIndex) {
        warn(
          "QUERY_UNINDEXED",
          q.line,
          `query on ${q.entity} performs a full scan: add an index on the key fields`
        );
      }
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
