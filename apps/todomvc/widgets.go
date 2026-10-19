// TodoMVC's widgets, declared in todomvc.crud: the two interactions the app spec defines on the
// keyboard and mouse that a form can't express. Everything else is a form post.
package main

import "crudspec/gogen/rt"

var widgets = map[string]func([]rt.Val, rt.WidgetHelpers) string{
	// a todo's title: double-click (or Enter) opens it for editing (the page for it, ?editing=)
	"edit_on_double_click": func(a []rt.Val, h rt.WidgetHelpers) string {
		href := rt.Esc(rt.Plain(rt.Arg(a, 1)))
		return `<label tabindex="0" data-href="` + href + `" ondblclick="location.href=this.dataset.href" onkeydown="if(event.key==='Enter')location.href=this.dataset.href">` +
			rt.Esc(rt.Plain(rt.Arg(a, 0))) + `</label>`
	},
	// the edit field just before it: focused at the end of its text; Escape cancels; leaving it
	// unchanged ends the edit (a changed one is saved: the form submits on change)
	"edit_keys": func(a []rt.Val, h rt.WidgetHelpers) string {
		cancel := rt.Esc(rt.Plain(rt.Arg(a, 0)))
		return `<script>(function(){var f=document.currentScript.previousElementSibling,i=f&&f.querySelector(".edit input, input.edit");if(!i)return;var was=i.value,c="` + cancel + `";` +
			`i.focus();i.setSelectionRange(i.value.length,i.value.length);` +
			`i.addEventListener("keydown",function(e){if(e.key==="Escape"){e.preventDefault();location.href=c}});` +
			`i.addEventListener("blur",function(){if(i.value===was)location.href=c})})()</script>`
	},
}
