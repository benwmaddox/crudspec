// A checker finding. Errors reject the spec; warnings are reported but don't.
export type Finding = {
  severity: "error" | "warning";
  code: string;
  where: string;      // the declaration, or the action that showed it
  message: string;
  trace?: string[];   // for dynamic findings: the actions from a seed state that show it
};
