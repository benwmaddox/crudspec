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
	"jump_to_newest": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<button type="button" class="` + h.DC("button") + `" onclick="document.querySelector('.messages')?.lastElementChild?.scrollIntoView({behavior:'smooth'})"><span class="` + h.DC("screen_reader") + `">Jump to the newest messages</span>↓</button>`
	},
	// installing the web app (pwa/_install_instructions)
	"pwa_install_instructions": func(a []rt.Val, h rt.WidgetHelpers) string {
		return `<p class="txt-small">Install Campfire from your browser's menu: "Install app" or "Add to Home Screen".</p>`
	},
}
