// A network's ad code, which a site administrator pasted: run in a sandboxed frame with no
// access to the page, its cookies or its origin, so the code can show an ad and open links in
// a new tab and nothing more.
class AdCode extends HTMLElement {
  connectedCallback() {
    if (this.dataset.done) return;
    this.dataset.done = "1";
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("title", "Advertisement");
    f.srcdoc = "<!doctype html><meta charset=utf-8><style>body{margin:0}</style>" + (this.getAttribute("code") || "");
    this.appendChild(f);
  }
}
customElements.define("ad-code", AdCode);
