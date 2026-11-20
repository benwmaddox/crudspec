// Tables in pages sort by a column when its heading is clicked: numbers as numbers, the rest
// as text. One element on the page handles every table, and tables a live update puts there.
class TableSort extends HTMLElement {
  connectedCallback() {
    if (window.__tableSort) return;
    window.__tableSort = true;
    const mark = () => document.querySelectorAll(".md table th").forEach((th) => { if (!th.dataset.sort) th.dataset.sort = "none"; });
    mark();
    new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", (e) => {
      const th = e.target.closest && e.target.closest(".md table th");
      if (!th) return;
      const table = th.closest("table"), body = table.tBodies[0];
      if (!body) return;
      const col = [...th.parentNode.children].indexOf(th);
      const dir = th.dataset.sort === "asc" ? "desc" : "asc";
      table.querySelectorAll("th").forEach((h) => (h.dataset.sort = "none"));
      th.dataset.sort = dir;
      const key = (tr) => (tr.children[col]?.textContent || "").trim();
      const num = (s) => { const n = parseFloat(s.replace(/[^0-9.+-]/g, "")); return /\d/.test(s) && !isNaN(n) ? n : null; };
      const rows = [...body.rows].sort((a, b) => {
        const x = key(a), y = key(b), nx = num(x), ny = num(y);
        const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
        return dir === "asc" ? c : -c;
      });
      rows.forEach((r) => body.appendChild(r));
    });
  }
}
customElements.define("table-sort", TableSort);
