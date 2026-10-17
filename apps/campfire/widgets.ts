// Campfire's own widgets, declared in campfire.crud ("widget name(params)") and loaded by the
// runtime with --widgets apps/campfire/widgets.ts. Each returns HTML for its arguments.
type H = { esc: (v: unknown) => string; plain: (v: unknown) => string; dc: (kind: string) => string; icon: string; label: string; cls: string; display: (r: any) => string };

export default {
  // /play sounds (sound.rb): a button that plays the sound's file from the assets
  sound([file]: unknown[], h: H) {
    return `<button class="${h.dc("plain_button")}" type="button" aria-label="Play sound" onclick="new Audio('/assets/${h.esc(h.plain(file))}').play()">🔊</button>`;
  },
  // reply (messages/_actions): quotes the message into the composer
  reply([text]: unknown[], h: H) {
    const quote = `> ${h.plain(text)}`.split("\n").join("\n> ");
    return `<button type="button" class="${h.esc(h.cls || h.dc("button"))}" onclick="const t=document.querySelector('#composer textarea');if(t){t.value=${h.esc(JSON.stringify(quote + "\n\n"))}+t.value;t.focus()}">${h.icon}<span class="${h.dc("screen_reader")}">${h.esc(h.label || "Reply")}</span></button>`;
  },
  // jump to the newest message (rooms/show: the "jump to bottom" button)
  jump_to_newest(_: unknown[], h: H) {
    return `<button type="button" class="${h.dc("button")}" onclick="document.querySelector('.messages')?.lastElementChild?.scrollIntoView({behavior:'smooth'})"><span class="${h.dc("screen_reader")}">Jump to the newest messages</span>↓</button>`;
  },
  // installing the web app (pwa/_install_instructions)
  pwa_install_instructions(_: unknown[], h: H) {
    return `<p class="txt-small">Install Campfire from your browser's menu: "Install app" or "Add to Home Screen".</p>`;
  },
};
