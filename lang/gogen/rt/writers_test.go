package rt

import (
	"encoding/base64"
	"strconv"
	"strings"
	"testing"
)

var _, _, _ = base64.RawURLEncoding, strconv.Itoa, strings.TrimSpace

// The UI helpers as they were, joining strings (from before the writers): each writer must give
// the same bytes.
func (sv *Server) oldWidget(rc *RCtx, name string, args []Val, wv WidgetVals) string {
	arg0 := Val(nil)
	if len(args) > 0 {
		arg0 = args[0]
	}
	lbl := wv.Label
	or := func(v Val, d string) string {
		if v == nil {
			return d
		}
		return Plain(v)
	}
	icon := sv.iconTag(wv.Icon, 20)
	switch name {
	case "copy_button":
		return `<button type="button" class="` + sv.dc("button") + `" onclick="navigator.clipboard.writeText(` + Esc(JSString(Plain(arg0))) + `)">` + icon + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "Copy")) + `</span></button>`
	case "share_button":
		// shown only where the browser can share (as Campfire's web-share controller does)
		return `<button type="button" class="` + sv.dc("button") + `" hidden data-web-share onclick="navigator.share && navigator.share({url: ` + Esc(JSString(Plain(sv.fileURLMaybe(arg0)))) + `})">` + icon + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "Share")) + `</span></button>`
	case "qr_link":
		return `<a class="` + sv.dc("button") + `" target="_blank" href="/_qr/` + base64.RawURLEncoding.EncodeToString([]byte(Plain(arg0))) + `">` + icon + `<span class="` + sv.dc("screen_reader") + `">` + Esc(or(lbl, "QR code")) + `</span></a>`
	case "lightbox":
		alt := ""
		if o, ok := arg0.(Obj); ok {
			alt = Plain(o["file"])
		}
		return `<a href="` + Esc(sv.fileURL(arg0)) + `" target="_blank"><img src="` + Esc(sv.fileURL(arg0)) + `" style="max-width:100%;max-height:20em" alt="` + Esc(alt) + `"></a>`
	case "push_permission":
		action := sv.App.Actions[wv.ArgName]
		if wv.ArgName == "" || action == nil {
			return ""
		}
		class := strings.TrimSpace(sv.dc("button") + " " + wv.Class)
		return `<button type="button" class="` + Esc(class) + `" hidden data-push-subscribe="/_do/` + Esc(action.Name) + `" data-push-params="` + Esc(wv.PushParams) + `" data-push-key="` + Esc(sv.vapidPublic) + `">` + icon + `<span data-push-label` + IfStr(icon != "", ` class="`+sv.dc("screen_reader")+`"`, "") + `>` + Esc(or(lbl, "Turn on notifications")) + `</span></button>`
	}
	return ""
}

func (sv *Server) oldAvatar(class string, large bool, u, label Val) string {
	l := ""
	if large {
		l = sv.dc("avatar_large")
	}
	return `<figure class="` + Esc(class) + ` ` + l + `"><img src="` + avatarURL(u) + `" alt="` + Esc(Plain(label)) + `"></figure>`
}

func (sv *Server) oldAvatarImg(u, label Val) string {
	if !present(label) {
		return `<img aria-hidden="true" src="` + avatarURL(u) + `" width="48" height="48">`
	}
	return `<img src="` + avatarURL(u) + `" alt="` + Esc(Plain(label)) + `" width="48" height="48">`
}

func (sv *Server) oldImage(class string, v, wd, ht, thumb Val, eager ...Val) string {
	ws, hs := "", ""
	if present(wd) {
		ws = `width="` + jsString(wd) + `"`
	}
	if present(ht) {
		hs = `height="` + jsString(ht) + `"`
	}
	src := sv.fileURL(v)
	if o, ok := v.(Obj); ok && present(thumb) && Plain(o["stored"]) != "" {
		if n := thumbWidth(Plain(thumb)); n > 0 {
			src += "?w=" + strconv.Itoa(n)
		}
	}
	if ws == "" && hs == "" {
		ws = strings.TrimSpace(fileSizeAttrs(src)) // the upload's own size, so the page keeps its space
	}
	// loads as it nears the screen (the browser's own loading="lazy", no script), unless it's eager:
	// a picture at the top of the page, which the browser should fetch first
	load := ` loading="lazy" decoding="async"`
	if len(eager) > 0 && Truthy(eager[0]) {
		load = ` fetchpriority="high"`
	}
	return `<img class="` + Esc(class) + `" src="` + Esc(src) + `" ` + ws + ` ` + hs + load + ` alt="">`
}

func (sv *Server) oldSwitch(icon Val, on, auto bool, link Val, label string) string {
	checked, a, l := "", "", ""
	if on {
		checked = "checked"
	}
	if auto {
		a = `onchange="this.form.requestSubmit()"`
	}
	if present(link) {
		l = `onchange="location.href=this.dataset.href" data-href="` + Esc(sv.screenURLFromVal(link)) + `"`
	}
	sw := `<label class="switch">` + sv.iconTag(icon, 20) + `<input type="checkbox" class="switch__input" ` + checked + ` ` + a + ` ` + l + `><span class="switch__btn round"></span>` + label + `</label>`
	if present(link) { // a switch that goes somewhere is a link (as Campfire's room type switch is)
		return `<a href="` + Esc(sv.screenURLFromVal(link)) + `" class="btn--faux flex-inline" tabindex="-1">` + sw + `</a>`
	}
	return `<div` + ClassAttr(sv.dc("row")) + `>` + sw + `</div>`
}

func TestWritersAsStrings(t *testing.T) {
	sv := &Server{UI: &UI{}, App: &App{Actions: map[string]*Action{"subscribe": {Name: "subscribe"}}}}
	texts := []Val{nil, "", "plain", `<b>"q" & 'a'</b>`, "/files/abc", "https://example.test/x?y=1&z=2", "pic.png", Obj{"stored": "k1", "file": "a <b>.png"}, Obj{"file": "only"}, int64(42)}
	same := func(what, got, want string) {
		if got != want {
			t.Errorf("%s:\n got %s\nwant %s", what, got, want)
		}
	}
	for _, x := range texts {
		for _, y := range texts {
			for _, name := range []string{"copy_button", "share_button", "qr_link", "lightbox", "push_permission", "unknown"} {
				for _, arg := range []string{"", "subscribe", "missing"} {
					wv := WidgetVals{Label: y, Icon: x, Class: " extra ", ArgName: arg, PushParams: `{"a":1}`}
					same("widget "+name, sv.Widget(nil, name, []Val{x}, wv), sv.oldWidget(nil, name, []Val{x}, wv))
				}
			}
			for _, large := range []bool{false, true} {
				same("avatar", sv.Avatar(Plain(x), large, y, x), sv.oldAvatar(Plain(x), large, y, x))
			}
			same("avatar img", sv.AvatarImg(x, y), sv.oldAvatarImg(x, y))
			for _, wd := range []Val{nil, "", int64(120)} {
				for _, ht := range []Val{nil, int64(80)} {
					for _, eager := range [][]Val{nil, {true}, {false}} {
						same("image", sv.Image(Plain(y), x, wd, ht, "small", eager...), sv.oldImage(Plain(y), x, wd, ht, "small", eager...))
						same("image no thumb", sv.Image("c", x, wd, ht, nil, eager...), sv.oldImage("c", x, wd, ht, nil, eager...))
					}
				}
			}
			for _, on := range []bool{false, true} {
				for _, auto := range []bool{false, true} {
					same("switch", sv.Switch(x, on, auto, y, "<span>L</span>"), sv.oldSwitch(x, on, auto, y, "<span>L</span>"))
				}
			}
		}
	}
}
