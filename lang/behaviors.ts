// Behaviors: what a page does in the browser without a round trip, written as attributes of an
// element and done by the runtime's own script (rt/render.go, liveScript). They move focus,
// scroll, play a sound, put text into a field, show or hide, and go to an address; they never
// change data (that is an action, on the server) and run no app code in the browser: their
// values are worked out on the server, as the page is drawn.
//
//   <button type="button" cs:click={[prepend(composer, quote), focus(composer)]}>Reply</button>
//   <Field name=title kind=text cs:ref=edit cs:shown={focus(edit)} cs:key_escape={go(cancel)} cs:blur_unchanged={go(cancel)} />
//   <button cs:hidden_while_in_view={last(message)} cs:click={scroll_to(last(message))}>Newest</button>
//
// - Each is written with cs: (crudspec's, never the browser's); the parser keeps the name after it.
// - cs:ref=name names an element (data-ref); a target is a name (the first element so named) or
//   last(name) (the last one). A target that isn't a field means the first field inside it: a
//   textarea, else an input, else an element people can edit (contenteditable).
// - A trigger's value is one action or a list of them, done in order.
import type { Expr } from "./parser.ts";
import { didYouMean } from "./didyoumean.ts";

// when: an element's event, the key pressed on it, or its appearing (on the page as it loads, or
// put there by a live update)
export const TRIGGERS: Record<string, string> = {
  click: "it is clicked",
  dblclick: "it is double-clicked",
  blur_unchanged: "it loses focus with its value as it was drawn",
  shown: "it appears: as the page loads, or when a live update puts it there",
};
// key_<name>: that key pressed while the element has focus (KeyboardEvent.key)
export const KEYS: Record<string, string> = {
  enter: "Enter", escape: "Escape", space: " ", tab: "Tab", backspace: "Backspace", delete: "Delete",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
};
// a binding, not a trigger: the element is hidden while its target is in view
export const BINDINGS: Record<string, string> = {
  hidden_while_in_view: "hidden while the target is in view (a button to jump to the newest message)",
};

// the actions: their arguments, a target (t) or a value (text: Text, url: Url)
export type ArgKind = "target" | "text" | "url";
export const ACTIONS: Record<string, { args: ArgKind[]; doc: string }> = {
  go: { args: ["url"], doc: "go to the address" },
  play: { args: ["text"], doc: "play the sound file: an asset's path, or an address" },
  prepend: { args: ["target", "text"], doc: "put the text at the start of the target field's value" },
  append: { args: ["target", "text"], doc: "put the text at the end of the target field's value" },
  focus: { args: ["target"], doc: "focus the target field, with the caret at the end of its text" },
  scroll_to: { args: ["target"], doc: "scroll the target into view, smoothly" },
};

export const isTrigger = (a: string) => a in TRIGGERS || (a.startsWith("key_") && a.slice(4) in KEYS);
export const isBinding = (a: string) => a in BINDINGS;
export const isBehavior = (a: string) => isTrigger(a) || isBinding(a);
// every behavior attribute name, for the reference and for errors
export const BEHAVIOR_ATTRS = [...Object.keys(TRIGGERS), ...Object.keys(KEYS).map((k) => `key_${k}`), ...Object.keys(BINDINGS)];

export type Target = { ref: string; last: boolean; pos: any };
export type Step = { action: string; target?: Target; value?: Expr; valueKind?: ArgKind; pos: any };
export type Problem = { code: string; message: string; pos: any };

// a target: name or last(name)
function targetOf(e: any, problems: Problem[], what: string): Target | undefined {
  if (e?.kind === "name") return { ref: e.name, last: false, pos: e.pos };
  if (e?.kind === "call" && e.name === "last" && e.args?.length === 1 && e.args[0].kind === "name") return { ref: e.args[0].name, last: true, pos: e.pos };
  problems.push({ code: "BEHAVIOR_TARGET", message: `${what} takes an element's ref: a name (cs:ref=composer on the element) or last(name)`, pos: e?.pos });
  return undefined;
}

// the steps of a trigger's value, and what's wrong with it
export function stepsOf(attr: string, v: Expr | true): { steps: Step[]; problems: Problem[] } {
  const problems: Problem[] = [], steps: Step[] = [];
  if (v === true) { problems.push({ code: "BEHAVIOR_VALUE", message: `cs:${attr} needs what to do: cs:${attr}={focus(name)}`, pos: undefined }); return { steps, problems }; }
  const items: any[] = (v as any).kind === "listlit" ? (v as any).items : [v];
  if (!items.length) problems.push({ code: "BEHAVIOR_VALUE", message: `cs:${attr}={[]} does nothing`, pos: (v as any).pos });
  for (const it of items) {
    if (it?.kind !== "call" || !(it.name in ACTIONS)) {
      const said = it?.kind === "lit" && typeof it.value === "string" ? ` (a script can't be given as text: "${String(it.value).slice(0, 30)}")` : it?.kind === "call" ? ` (${it.name} isn't one${didYouMean(it.name, Object.keys(ACTIONS))})` : "";
      problems.push({ code: "BEHAVIOR_VALUE", message: `cs:${attr} takes actions: ${Object.keys(ACTIONS).map((a) => `${a}(${ACTIONS[a].args.join(", ")})`).join(", ")}, or a list of them${said}`, pos: it?.pos ?? (v as any).pos });
      continue;
    }
    const spec = ACTIONS[it.name];
    if ((it.args?.length ?? 0) !== spec.args.length || Object.keys(it.named ?? {}).length) {
      problems.push({ code: "BEHAVIOR_ARGS", message: `${it.name} takes ${spec.args.length === 1 ? "one argument" : `${spec.args.length} arguments`}: ${it.name}(${spec.args.join(", ")})`, pos: it.pos });
      continue;
    }
    const step: Step = { action: it.name, pos: it.pos };
    spec.args.forEach((k, i) => {
      if (k === "target") step.target = targetOf(it.args[i], problems, `${it.name}'s first argument`);
      else { step.value = it.args[i]; step.valueKind = k; }
    });
    steps.push(step);
  }
  return { steps, problems };
}

// a binding's target
export function bindingTarget(attr: string, v: Expr | true): { target?: Target; problems: Problem[] } {
  const problems: Problem[] = [];
  if (v === true) return { problems: [{ code: "BEHAVIOR_VALUE", message: `cs:${attr} needs a target: cs:${attr}={last(name)}`, pos: undefined }] };
  return { target: targetOf(v, problems, attr), problems };
}

// the value expressions in an element's behaviors (to check, type and count as reads)
export function behaviorValues(attrs: Record<string, Expr | true>): Expr[] {
  const out: Expr[] = [];
  for (const [a, v] of Object.entries(attrs)) if (isTrigger(a)) for (const s of stepsOf(a, v).steps) if (s.value) out.push(s.value);
  return out;
}

// every ref the spec declares (cs:ref=name on any element, in any screen, layout or component)
export function declaredRefs(decls: any[]): Set<string> {
  const out = new Set<string>();
  const walk = (x: any): void => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.kind === "el" && x.attrs?.ref && x.attrs.ref !== true && x.attrs.ref.kind === "refname") out.add(x.attrs.ref.name);
    for (const [k, v] of Object.entries(x)) if (k !== "pos") walk(v);
  };
  walk(decls);
  return out;
}
