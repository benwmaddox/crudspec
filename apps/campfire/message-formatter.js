// <message-formatter>: Campfire's message formatting, as Rails does it in the browser
// (models/message_formatter.js, controllers/local_time_controller.js).
// - A day's first message shows its day.
// - A message from the same person within five minutes of their last joins it (threaded).
// - The day is shown in the reader's own words ("October 20, 2026").
// It runs again whenever the list changes. It works in the browser because a message's look
// depends on its neighbor, which the server's per-message fragments can't see. Declared in
// campfire.crud: element message-formatter() from "message-formatter.js".
customElements.define("message-formatter", class extends HTMLElement {
  connectedCallback() {
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
    const ts = (m) => {
      const t = m.querySelector(".message__day-separator time[datetime], .message__day-separator[datetime], time[datetime]");
      return t ? Date.parse(t.getAttribute("datetime")) : NaN;
    };
    const run = () => {
      document.querySelectorAll(".messages").forEach((list) => {
        let prev = null;
        list.querySelectorAll(":scope > .message, :scope > * > .message").forEach((m) => {
          const t = ts(m), p = prev && ts(prev);
          m.classList.toggle("message--first-of-day", !prev || isNaN(t) || isNaN(p) || day.format(new Date(p)) !== day.format(new Date(t)));
          m.classList.toggle("message--threaded", !!prev && prev.dataset.userId === m.dataset.userId && t - p < 300000);
          prev = m;
          const d = m.querySelector(".message__day-separator time[datetime], .message__day-separator[datetime]");
          if (d && !d.dataset.local) {
            d.dataset.local = "1";
            d.textContent = new Date(d.getAttribute("datetime")).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
          }
        });
      });
    };
    run();
    this.observer = new MutationObserver(run);
    this.observer.observe(document.getElementById("message-area") || document.body, { childList: true, subtree: true });
  }
  disconnectedCallback() { this.observer?.disconnect(); }
});
