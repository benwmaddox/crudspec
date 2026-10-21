package rt

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Signals: something ephemeral, never stored (typing, say), sent from one page to the pages of
// the people a signal's `to` names. A page that shows <Signal name(args)> listens on its live
// stream (/_events?signals=name:args); a page sends with POST /_signal/name:args. Both are
// allowed only when the signal's requires holds for who asks, and listening only for someone
// in its to; a message reaches the listeners in to as it is when it's sent, but not its sender.
// The runtime adds who sent it (from: id and display); the page sends only the fields the
// signal carries, of their types.

// SignalDecl is a declared signal, compiled (gen.ts).
type SignalDecl struct {
	Name    string
	Coerce  func(parts []string, s *Sess) map[string]Val // its arguments, from the address
	Check   func(sv *Server, rc *RCtx) (bool, Val)       // its requires, and then its to (a set)
	Carries map[string]string                            // what a page may send: a field's type (Text, Int, Bool)
}

type sigSub struct {
	actor Ref
	ch    chan string
}

// sigHub keeps who listens to what, by signal and arguments (typing:42)
type sigHub struct {
	mu   sync.Mutex
	subs map[string]map[*sigSub]bool
}

func (h *sigHub) add(key string, s *sigSub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs == nil {
		h.subs = map[string]map[*sigSub]bool{}
	}
	if h.subs[key] == nil {
		h.subs[key] = map[*sigSub]bool{}
	}
	h.subs[key][s] = true
}

func (h *sigHub) remove(key string, s *sigSub) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs[key], s)
	if len(h.subs[key]) == 0 {
		delete(h.subs, key)
	}
}

// send gives msg to key's listeners that to holds, not from (a full listener misses it)
func (h *sigHub) send(key string, to func(Ref) bool, from Ref, msg string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for s := range h.subs[key] {
		if s.actor == from || !to(s.actor) {
			continue
		}
		select {
		case s.ch <- msg:
			n++
		default:
		}
	}
	return n
}

// signalCheck is whether who may send or hear the signal key names, and its audience
func (sv *Server) signalCheck(key string, who Who, r *HTTPReq) (*SignalDecl, Set, bool) {
	name, raw, _ := strings.Cut(key, ":")
	d := sv.UI.Signals[name]
	actor, isRef := who.Actor.(Ref)
	if d == nil || !isRef || actor.ID == 0 {
		return nil, Set{}, false
	}
	parts := strings.Split(raw, ",")
	rc := &RCtx{Vars: d.Coerce(parts, r.Sess), Who: who, Req: r, P: newPage(), sv: sv}
	defer rc.P.release()
	ok, to := d.Check(sv, rc)
	set, isSet := to.(Set)
	return d, set, ok && isSet
}

// listen subscribes a live stream to the signals its page shows (that it may hear); stop ends it
func (sv *Server) listen(keys []string, who Who, r *HTTPReq) (<-chan string, func()) {
	ch := make(chan string, 32)
	actor, _ := who.Actor.(Ref)
	var mine []string
	sub := &sigSub{actor: actor, ch: ch}
	for _, k := range keys {
		if k == "" || len(mine) >= 16 {
			continue
		}
		if _, to, ok := sv.signalCheck(k, who, r); ok && InSet(actor, to) {
			sv.signals.add(k, sub)
			mine = append(mine, k)
		}
	}
	return ch, func() {
		for _, k := range mine {
			sv.signals.remove(k, sub)
		}
	}
}

// sendSignal is POST /_signal/<name>:<args>: the fields the signal carries, as JSON
func (sv *Server) sendSignal(w http.ResponseWriter, r *HTTPReq, who Who, key string) {
	d, to, ok := sv.signalCheck(key, who, r)
	if !ok {
		status(w, 403, "")
		return
	}
	var in map[string]any
	if len(r.Text) > 4096 || json.Unmarshal([]byte(r.Text), &in) != nil {
		status(w, 422, "")
		return
	}
	actor := who.Actor.(Ref)
	msg := map[string]any{}
	for k, t := range d.Carries {
		v, has := in[k]
		if !has {
			continue
		}
		switch t {
		case "Text":
			s, isText := v.(string)
			if !isText || utf8.RuneCountInString(s) > 200 {
				status(w, 422, "")
				return
			}
			msg[k] = s
		case "Int":
			f, isNum := v.(float64)
			if !isNum || f != float64(int64(f)) {
				status(w, 422, "")
				return
			}
			msg[k] = int64(f)
		case "Bool":
			b, isBool := v.(bool)
			if !isBool {
				status(w, 422, "")
				return
			}
			msg[k] = b
		}
	}
	out, _ := json.Marshal(map[string]any{"signal": key, "from": map[string]any{"id": actor.ID, "name": sv.displayOf(r.Sess, actor)}, "data": msg})
	sv.signals.send(key, func(a Ref) bool { return InSet(a, to) }, actor, string(out))
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(204)
}

// SignalTag is <Signal name(args)>: where the page shows it, and its key for the live stream.
// An indicator shows who else is typing in its form (the live script sends start while one
// types, stop on sending or emptying it; a name goes after 5 s without a start): the theme's
// signal class, signal_active while someone is, and signal_author for the names.
func (sv *Server) SignalTag(rc *RCtx, name string, args []Val, indicator bool) string {
	parts := make([]string, len(args))
	for i, v := range args {
		if r, ok := v.(Ref); ok {
			parts[i] = strconv.FormatInt(r.ID, 10)
		} else {
			parts[i] = EncodeURIComponent(Plain(v))
		}
	}
	key := name + ":" + strings.Join(parts, ",")
	ind := ""
	if indicator {
		ind = ` data-indicator data-active-class="` + Esc(sv.dc("signal_active")) + `"`
	}
	return `<div class="` + Esc(sv.dc("signal")) + `" data-signal="` + Esc(key) + `"` + ind + ` aria-live="polite"><div class="` + Esc(sv.dc("signal_author")) + `"></div></div>`
}

// SignalPart is a signal's i-th argument as its address has it
func SignalPart(parts []string, i int) string {
	if i >= len(parts) {
		return ""
	}
	v, err := url.PathUnescape(parts[i])
	if err != nil {
		return ""
	}
	return v
}
