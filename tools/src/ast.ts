// AST for crudspec v1 (docs/LANGUAGE.md).

export type Pos = { line: number; col: number };

export type TypeRef =
  | { kind: "named"; name: string; optional: boolean }
  | { kind: "set"; of: string };

export type Field = {
  name: string;
  type: TypeRef;
  onDelete: "cascade" | "restrict";
  default?: Expr;
  pos: Pos;
};

export type EntityDecl = {
  kind: "entity";
  name: string;
  singleton: boolean;
  fields: Field[];
  uniques: string[][];
  invariants: Expr[];
  pos: Pos;
};

export type EnumDecl = { kind: "enum"; name: string; values: string[]; pos: Pos };
export type Param = { name: string; type: TypeRef; pos: Pos };
export type PredicateDecl = { kind: "predicate"; name: string; params: Param[]; body: Expr; pos: Pos };
export type GateDecl = { kind: "gate"; name: string; cond: Expr; outcome: string; pos: Pos };
export type ActionDecl = { kind: "action"; name: string; params: Param[]; skips: string[]; body: Stmt[]; pos: Pos };
export type TriggerEvent =
  | { kind: "create"; entity: string }
  | { kind: "update"; entity: string; field: string }
  | { kind: "delete"; entity: string }
  | { kind: "event"; event: string };
export type TriggerDecl = { kind: "trigger"; on: TriggerEvent; bind: string; when?: Expr; body: Stmt[]; pos: Pos };
export type WorkflowDecl = { kind: "workflow"; event: string; bind: string; steps: { name: string; body: Stmt[] }[]; pos: Pos };
export type PermissionDecl = { kind: "permission"; entity: string; cond: Expr; pos: Pos };
export type ViewDecl = {
  kind: "view";
  name: string;
  params: Param[];
  requires: { cond: Expr; outcome: string }[];
  rows: { entity: string; where?: Expr };
  orderBy: string;
  window?: { size: number; end: "last" | "first"; unless?: Expr };
  pos: Pos;
};

export type Decl = EntityDecl | EnumDecl | PredicateDecl | GateDecl | ActionDecl | TriggerDecl | WorkflowDecl | PermissionDecl | ViewDecl;
export type Spec = { decls: Decl[] };

export type Expr =
  | { kind: "lit"; value: string | number | boolean | null; pos: Pos }
  | { kind: "name"; name: string; pos: Pos }
  | { kind: "rowfield"; name: string; pos: Pos }        // .f inside a where
  | { kind: "it"; pos: Pos }
  | { kind: "field"; target: Expr; name: string; pos: Pos }
  | { kind: "unary"; op: "not"; arg: Expr; pos: Pos }
  | { kind: "binary"; op: string; left: Expr; right: Expr; pos: Pos }
  | { kind: "setlit"; items: Expr[]; pos: Pos }
  | { kind: "if"; cond: Expr; then: Expr; else: Expr; pos: Pos }
  | { kind: "call"; name: string; args: Expr[]; pos: Pos }
  | { kind: "query"; op: "exists" | "count" | "the"; entity: string; where?: Expr; pos: Pos }
  | { kind: "all"; entity: string; where?: Expr; cond: Expr; pos: Pos };

export type Assign = { name: string; value: Expr };

export type Stmt =
  | { kind: "require"; cond: Expr; outcome: string; pos: Pos }
  | { kind: "create"; entity: string; fields: Assign[]; as?: string; ensure: boolean; pos: Pos }
  | { kind: "set"; target: Expr; name: string; value: Expr; pos: Pos }
  | { kind: "delete"; target: Expr; pos: Pos }
  | { kind: "deleteWhere"; entity: string; where?: Expr; pos: Pos }
  | { kind: "foreach"; bind: string; entity: string; where?: Expr; body: Stmt[]; pos: Pos }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[]; pos: Pos }
  | { kind: "emit"; event: string; args: Expr[]; pos: Pos }
  | { kind: "reject"; outcome: string; pos: Pos };

export const OUTCOMES = ["ok", "forbidden", "not_found", "blocked", "invalid", "unauthenticated"];
