// Dark by default; this button switches to light and back, and the browser remembers the choice.
// The choice is applied as early as the module runs, on every page (each page loads the script).
const KEY = "gamewiki-theme";
const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const apply = (t) => { if (t === "light") document.documentElement.dataset.theme = "light"; else delete document.documentElement.dataset.theme; };
apply(read());

class ThemeToggle extends HTMLElement {
  connectedCallback() {
    if (this.firstChild) return;
    const b = document.createElement("button");
    b.type = "button";
    const label = () => {
      const light = document.documentElement.dataset.theme === "light";
      b.textContent = light ? "☾ Dark" : "☀ Light";
      b.setAttribute("aria-label", light ? "Switch to the dark theme" : "Switch to the light theme");
    };
    label();
    b.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      try { localStorage.setItem(KEY, next); } catch { /* private window: this page only */ }
      apply(next);
      document.querySelectorAll("theme-toggle button").forEach((x) => x.dispatchEvent(new Event("relabel")));
    });
    b.addEventListener("relabel", label);
    this.appendChild(b);
  }
}
customElements.define("theme-toggle", ThemeToggle);
