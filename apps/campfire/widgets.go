// Campfire's own widgets, declared in campfire.crud ("widget name(params)"), for the compiled
// app (lang/gogen); widgets.ts has the same markup for the TypeScript runtime.
package main

import (
	"strings"

	"crudspec/gogen/rt"
)

var widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{
	// /play sounds (sound.rb): a button that plays the sound's file from the assets
	"sound": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<button class="` + h.DC("plain_button") + `" type="button" aria-label="Play sound" onclick="new Audio('/assets/` + rt.Esc(rt.Plain(rt.Arg(a, 0))) + `').play()">🔊</button>`
	},
	// reply (messages/_actions): quotes the message into the composer
	"reply": func(a []rt.Val, h rt.WidgetHelpers) string {
		quote := strings.Join(strings.Split("> "+rt.Plain(rt.Arg(a, 0)), "\n"), "\n> ")
		cls := h.Cls
		if cls == "" {
			cls = h.DC("button")
		}
		label := h.Label
		if label == "" {
			label = "Reply"
		}
		return `<button type="button" class="` + rt.Esc(cls) + `" onclick="const t=document.querySelector('#composer textarea');if(t){t.value=` + rt.Esc(rt.JSString(quote+"\n\n")) + `+t.value;t.focus()}">` + h.Icon + `<span class="` + h.DC("screen_reader") + `">` + rt.Esc(label) + `</span></button>`
	},
	// jump to the newest message (rooms/show: the "jump to bottom" button)
	"jump_to_newest": func(a []rt.Val, h rt.WidgetHelpers) string { // rooms_helper.rb button_to_jump_to_newest_message: shown once the newest message is out of view
		return `<button type="button" class="message-area__return-to-latest btn" hidden onclick="document.querySelector('.messages')?.lastElementChild?.scrollIntoView({behavior:'smooth'})"><img src="` + h.Asset("arrow-down.svg") + `" width="20" height="20" aria-hidden="true"><span class="` + h.DC("screen_reader") + `">Jump to newest message</span></button>` +
			`<script>(function(b){var l=document.querySelector(".messages");if(!l||!window.IntersectionObserver)return;var o=new IntersectionObserver(function(e){b.hidden=e[0].isIntersecting});var w=function(){o.disconnect();if(l.lastElementChild)o.observe(l.lastElementChild)};w();new MutationObserver(w).observe(l,{childList:true})})(document.currentScript.previousElementSibling)</script>`
	},
	// models/message_formatter.js: a day's first message shows its day; a message from the same
	// person within five minutes of their last joins it (threaded); again whenever the list changes
	"format_messages": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<script>(function(){var day=new Intl.DateTimeFormat(undefined,{dateStyle:"short"});` +
			`function ts(m){var t=m.querySelector(".message__day-separator time[datetime], .message__day-separator[datetime], time[datetime]");return t?Date.parse(t.getAttribute("datetime")):NaN}` +
			`function run(){document.querySelectorAll(".messages").forEach(function(l){var prev=null;l.querySelectorAll(":scope > .message, :scope > * > .message").forEach(function(m){var t=ts(m),p=prev&&ts(prev);` +
			`m.classList.toggle("message--first-of-day",!prev||isNaN(t)||isNaN(p)||day.format(new Date(p))!==day.format(new Date(t)));` +
			`m.classList.toggle("message--threaded",!!prev&&prev.dataset.userId===m.dataset.userId&&t-p<300000);prev=m;` +
			// controllers/local_time_controller.js: the day in the reader's own words ("October 20, 2026")
			`var d=m.querySelector(".message__day-separator time[datetime], .message__day-separator[datetime]");if(d&&!d.dataset.local){d.dataset.local=1;d.textContent=new Date(d.getAttribute("datetime")).toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"})}})})}` +
			`run();new MutationObserver(run).observe(document.getElementById("message-area")||document.body,{childList:true,subtree:true})})()</script>`
	},
	// installing the web app (pwa/_install_instructions)
	"pwa_install_instructions": func(a []rt.Val, h rt.WidgetHelpers) string { // pwa/_install_instructions
		return `<details class="notifications-help pwa__instructions hide-in-pwa"><summary class="btn"><img src="` + h.Asset("external/install.svg") + `" width="20" height="20" aria-hidden="true"><strong>Install Campfire as a web app.</strong></summary><p class="txt-small">Install Campfire from your browser's menu: "Install app" or "Add to Home Screen".</p></details>`
	},
}
