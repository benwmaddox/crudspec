package rt

import (
	"sort"
	"strings"
)

// renderTo writes elements into one buffer: containers write their opening markup, their
// children, then their closing markup, so a page is built without copying it at every level.
// The order things are evaluated in is the TypeScript runtime's (attributes, then children).
func (sv *Server) renderTo(els []*El, rc *RCtx, w *strings.Builder) {
	for i := 0; i < len(els); i++ {
		el := els[i]
		if el.Name == "button" {
			hs := []*El{}
			for i+1 < len(els) && els[i+1].Name == "on" {
				i++
				hs = append(hs, els[i])
			}
			w.WriteString(sv.renderEl(el, rc, hs))
		} else if el.Name != "on" {
			sv.emit(el, rc, w)
		}
	}
}

func (sv *Server) emit(el *El, rc *RCtx, w *strings.Builder) {
	switch el.Name {
	case "if", "each", "list", "use", "row", "column", "section", "link", "menu", "popup", "dialog", "frame":
	default:
		w.WriteString(sv.renderEl(el, rc, nil))
		return
	}
	if !sv.shown(el, rc) {
		return
	}
	switch el.Name {
	case "if":
		if Truthy(rc.ev(el.Head)) {
			sv.renderTo(el.Children, rc, w)
		} else if el.Else != nil {
			sv.renderTo(el.Else, rc, w)
		}
	case "each":
		var items []Val
		switch x := rc.ev(el.Over).(type) {
		case List:
			items = x
		case Set:
			for _, id := range x.IDs {
				items = append(items, Ref{E: x.E, ID: id})
			}
		}
		for _, x := range items {
			vars := copyVars(rc.Vars)
			vars[el.Bind] = x
			sv.renderTo(el.Children, rc.with(vars), w)
		}
	case "list":
		sv.listTo(el, rc, w)
	case "use":
		comp := sv.UI.Components[el.Call]
		vars := map[string]Val{}
		for i, p := range comp.Params {
			var v Val
			if i < len(el.CallArgs) {
				v = rc.ev(el.CallArgs[i])
			}
			vars[p] = v
		}
		sv.renderTo(comp.Body, rc.with(vars), w)
	case "row":
		d := sv.attr(el, "data", rc)
		banned := ""
		if present(sv.attr(el, "banned", rc)) {
			banned = " banned"
		}
		rid := sv.attr(el, "id", rc)
		w.WriteString("<div")
		if present(rid) {
			w.WriteString(` id="` + Esc(Plain(rid)) + `"`)
		}
		class := sv.dc("row")
		if el.Attrs["class"] != nil {
			class = sv.cls(el, rc, "")
		}
		w.WriteString(` class="` + Esc(class) + banned + `"`)
		if o, ok := d.(Obj); ok {
			keys := make([]string, 0, len(o))
			for k := range o {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				w.WriteString(` data-` + strings.ReplaceAll(k, "_", "-") + `="` + Esc(serial(o[k])) + `"`)
			}
		}
		w.WriteString(">")
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</div>")
	case "column":
		class := sv.dc("column")
		if el.Attrs["class"] != nil {
			class = sv.cls(el, rc, "")
		}
		w.WriteString(`<div class="` + Esc(class) + `">`)
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</div>")
	case "section":
		lg := sv.attr(el, "legend", rc)
		banned := ""
		if present(sv.attr(el, "banned", rc)) {
			banned = " banned"
		}
		if present(lg) {
			w.WriteString(`<fieldset class="` + Esc(sv.cls(el, rc, "")) + banned + `"><legend><strong>` + Esc(Plain(lg)) + `</strong></legend>`)
			sv.renderTo(el.Children, rc, w)
			w.WriteString("</fieldset>")
			return
		}
		w.WriteString(`<section class="` + Esc(sv.cls(el, rc, "")) + banned + `" id="` + Esc(Plain(sv.attr(el, "id", rc))) + `">`)
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</section>")
	case "link":
		icon := sv.attr(el, "icon", rc)
		href := sv.targetURL(el.T, rc)
		unread := ""
		if e := el.Attrs["unread"]; e != nil && Truthy(rc.ev(e)) {
			unread = " unread"
		}
		base := ""
		if len(el.Children) == 0 {
			base = sv.dc("button")
		}
		w.WriteString(`<a href="` + Esc(href) + `" class="` + Esc(sv.cls(el, rc, base)) + unread + `">` + sv.iconTag(icon, 20) + sv.label(el, rc))
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</a>")
	case "menu":
		icon := sv.attr(el, "icon", rc)
		if !present(icon) && !el.Has("label") {
			w.WriteString(`<menu class="` + Esc(sv.cls(el, rc, sv.dc("menu"))) + `">`)
			sv.renderTo(el.Children, rc, w)
			w.WriteString("</menu>")
			return
		}
		w.WriteString(`<details class="` + sv.dc("dropdown") + `"><summary class="` + sv.dc("button") + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + `</summary><menu class="` + sv.dc("dropdown_panel") + `">`)
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</menu></details>")
	case "popup":
		icon := sv.attr(el, "icon", rc)
		panel := sv.attr(el, "panel", rc)
		pc := sv.dc("dropdown_panel")
		if panel != nil {
			pc = Plain(panel)
		}
		w.WriteString(`<details class="` + sv.dc("dropdown") + `"><summary class="` + Esc(sv.cls(el, rc, sv.dc("button"))) + `">` + sv.iconTag(icon, 20) + sv.label(el, rc) + `</summary><div class="` + Esc(pc) + `">`)
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</div></details>")
	case "dialog", "frame":
		w.WriteString("<div>")
		sv.renderTo(el.Children, rc, w)
		w.WriteString("</div>")
	}
}
