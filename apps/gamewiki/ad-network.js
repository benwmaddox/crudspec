// An AdSense unit: loads Google's ad script once per page and asks it to fill this unit.
class AdNetwork extends HTMLElement {
  connectedCallback() {
    if (this.dataset.done) return;
    this.dataset.done = "1";
    const client = this.getAttribute("client"), unit = this.getAttribute("unit");
    if (!/^ca-pub-\d+$/.test(client || "") || !/^\d+$/.test(unit || "")) return;
    if (!document.querySelector("script[data-adsbygoogle]")) {
      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.dataset.adsbygoogle = "1";
      s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(client);
      document.head.appendChild(s);
    }
    const ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.display = "block";
    ins.dataset.adClient = client;
    ins.dataset.adSlot = unit;
    ins.dataset.adFormat = "auto";
    ins.dataset.fullWidthResponsive = "true";
    this.appendChild(ins);
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }
}
customElements.define("ad-network", AdNetwork);
