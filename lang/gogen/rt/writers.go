package rt

import (
	"bytes"
	"encoding/base64"
	"strconv"
	"strings"
)

// The writers of the UI helpers that make an element's markup (Widget, Avatar, AvatarImg, Image,
// Switch): the same bytes, written straight into the page instead of joined into a string
// first. The string forms call these, so each element's markup is written in one place.

func (sv *Server) WriteWidget(w *bytes.Buffer, rc *RCtx, name string, args []Val, wv WidgetVals) {
	arg0 := Val(nil)
	if len(args) > 0 {
		arg0 = args[0]
	}
	label := func(d string) {
		if wv.Label == nil {
			WriteEsc(w, d)
		} else {
			WriteEsc(w, Plain(wv.Label))
		}
	}
	icon := sv.iconTag(wv.Icon, 20)
	srLabel := func(d, end string) {
		w.WriteString(icon)
		w.WriteString(`<span class="`)
		w.WriteString(sv.dc("screen_reader"))
		w.WriteString(`">`)
		label(d)
		w.WriteString(`</span>`)
		w.WriteString(end)
	}
	switch name {
	case "copy_button":
		w.WriteString(`<button type="button" class="`)
		w.WriteString(sv.dc("button"))
		w.WriteString(`" onclick="navigator.clipboard.writeText(`)
		WriteEsc(w, JSString(Plain(arg0)))
		w.WriteString(`)">`)
		srLabel("Copy", `</button>`)
	case "share_button":
		// shown only where the browser can share (as Campfire's web-share controller does)
		w.WriteString(`<button type="button" class="`)
		w.WriteString(sv.dc("button"))
		w.WriteString(`" hidden data-web-share onclick="navigator.share && navigator.share({url: `)
		WriteEsc(w, JSString(Plain(sv.fileURLMaybe(arg0))))
		w.WriteString(`})">`)
		srLabel("Share", `</button>`)
	case "qr_link":
		w.WriteString(`<a class="`)
		w.WriteString(sv.dc("button"))
		w.WriteString(`" target="_blank" href="/_qr/`)
		w.WriteString(base64.RawURLEncoding.EncodeToString([]byte(Plain(arg0))))
		w.WriteString(`">`)
		srLabel("QR code", `</a>`)
	case "lightbox":
		alt := ""
		if o, ok := arg0.(Obj); ok {
			alt = Plain(o["file"])
		}
		u := sv.fileURL(arg0)
		w.WriteString(`<a href="`)
		WriteEsc(w, u)
		w.WriteString(`" target="_blank"><img src="`)
		WriteEsc(w, u)
		w.WriteString(`" style="max-width:100%;max-height:20em" alt="`)
		WriteEsc(w, alt)
		w.WriteString(`"></a>`)
	case "push_permission":
		action := sv.App.Actions[wv.ArgName]
		if wv.ArgName == "" || action == nil {
			return
		}
		w.WriteString(`<button type="button" class="`)
		WriteEsc(w, strings.TrimSpace(sv.dc("button")+" "+wv.Class))
		w.WriteString(`" hidden data-push-subscribe="/_do/`)
		WriteEsc(w, action.Name)
		w.WriteString(`" data-push-params="`)
		WriteEsc(w, wv.PushParams)
		w.WriteString(`" data-push-key="`)
		WriteEsc(w, sv.vapidPublic)
		w.WriteString(`">`)
		w.WriteString(icon)
		w.WriteString(`<span data-push-label`)
		if icon != "" {
			w.WriteString(` class="`)
			w.WriteString(sv.dc("screen_reader"))
			w.WriteString(`"`)
		}
		w.WriteString(`>`)
		label("Turn on notifications")
		w.WriteString(`</span></button>`)
	}
}

func (sv *Server) WriteAvatar(w *bytes.Buffer, class string, large bool, u, label Val) {
	w.WriteString(`<figure class="`)
	WriteEsc(w, class)
	w.WriteString(` `)
	if large {
		w.WriteString(sv.dc("avatar_large"))
	}
	w.WriteString(`"><img src="`)
	w.WriteString(avatarURL(u))
	w.WriteString(`" alt="`)
	WriteEsc(w, Plain(label))
	w.WriteString(`"></figure>`)
}

func (sv *Server) WriteAvatarImg(w *bytes.Buffer, u, label Val) {
	if !present(label) {
		w.WriteString(`<img aria-hidden="true" src="`)
		w.WriteString(avatarURL(u))
		w.WriteString(`" width="48" height="48">`)
		return
	}
	w.WriteString(`<img src="`)
	w.WriteString(avatarURL(u))
	w.WriteString(`" alt="`)
	WriteEsc(w, Plain(label))
	w.WriteString(`" width="48" height="48">`)
}

func (sv *Server) WriteImage(w *bytes.Buffer, class string, v, wd, ht, thumb Val, eager ...Val) {
	src := sv.fileURL(v)
	if o, ok := v.(Obj); ok && present(thumb) && Plain(o["stored"]) != "" {
		if n := thumbWidth(Plain(thumb)); n > 0 {
			src += "?w=" + strconv.Itoa(n)
		}
	}
	w.WriteString(`<img class="`)
	WriteEsc(w, class)
	w.WriteString(`" src="`)
	WriteEsc(w, src)
	w.WriteString(`" `)
	if !present(wd) && !present(ht) {
		w.WriteString(strings.TrimSpace(fileSizeAttrs(src))) // the upload's own size, so the page keeps its space
		w.WriteString(` `)
	} else {
		if present(wd) {
			w.WriteString(`width="`)
			w.WriteString(jsString(wd))
			w.WriteString(`"`)
		}
		w.WriteString(` `)
		if present(ht) {
			w.WriteString(`height="`)
			w.WriteString(jsString(ht))
			w.WriteString(`"`)
		}
	}
	// loads as it nears the screen (the browser's own loading="lazy", no script), unless it's eager:
	// a picture at the top of the page, which the browser should fetch first
	if len(eager) > 0 && Truthy(eager[0]) {
		w.WriteString(` fetchpriority="high"`)
	} else {
		w.WriteString(` loading="lazy" decoding="async"`)
	}
	w.WriteString(` alt="">`)
}

func (sv *Server) WriteSwitch(w *bytes.Buffer, icon Val, on, auto bool, link Val, label string) {
	href := ""
	if present(link) { // a switch that goes somewhere is a link (as Campfire's room type switch is)
		href = sv.screenURLFromVal(link)
		w.WriteString(`<a href="`)
		WriteEsc(w, href)
		w.WriteString(`" class="btn--faux flex-inline" tabindex="-1">`)
	} else {
		w.WriteString(`<div`)
		WriteClassAttr(w, sv.dc("row"))
		w.WriteString(`>`)
	}
	w.WriteString(`<label class="switch">`)
	w.WriteString(sv.iconTag(icon, 20))
	w.WriteString(`<input type="checkbox" class="switch__input" `)
	if on {
		w.WriteString("checked")
	}
	w.WriteString(` `)
	if auto {
		w.WriteString(`onchange="this.form.requestSubmit()"`)
	}
	w.WriteString(` `)
	if present(link) {
		w.WriteString(`onchange="location.href=this.dataset.href" data-href="`)
		WriteEsc(w, href)
		w.WriteString(`"`)
	}
	w.WriteString(`><span class="switch__btn round"></span>`)
	w.WriteString(label)
	w.WriteString(`</label>`)
	if present(link) {
		w.WriteString(`</a>`)
	} else {
		w.WriteString(`</div>`)
	}
}

// strOf is what a writer writes, as a string (the string forms of the helpers)
func strOf(f func(w *bytes.Buffer)) string {
	b := GetBuf()
	f(b)
	s := b.String()
	PutBuf(b)
	return s
}
