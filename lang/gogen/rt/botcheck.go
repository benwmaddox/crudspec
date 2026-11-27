package rt

import (
	"bytes"
	"crypto/subtle"
	"strconv"
	"strings"
	"time"
)

// bot_check (an action's setting): its forms carry a field a person never sees and leaves empty,
// and the time the form was shown, signed. A post with the field filled, sent sooner than a person
// fills a form (2 s), or without a good stamp (forged, or a day old) is refused as blocked, before
// the action runs. It is for a page's forms (/_do/): agents, the API and spec tests don't post them.
// The time is the server's own, not the app's clock, which a test may hold still.

const botMinMS, botMaxMS = 2000, 24 * 3600 * 1000

// BotFields writes the two fields into a form
func (sv *Server) BotFields(w *bytes.Buffer) {
	now := strconv.FormatInt(time.Now().UnixMilli(), 36)
	w.WriteString(`<div aria-hidden="true" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden"><label>Leave this empty <input type="text" name="__hp" value="" tabindex="-1" autocomplete="off"></label></div><input type="hidden" name="__bt" value="`)
	w.WriteString(now + "." + sv.App.Mac("bot:"+now))
	w.WriteString(`">`)
}

// botRefused says why a form post fails the check, or "" when it passes
func (sv *Server) botRefused(r *HTTPReq) string {
	if hp, _ := r.body("__hp"); hp != "" {
		return "a field people leave empty was filled"
	}
	stamp, _ := r.body("__bt")
	at, mac, ok := strings.Cut(stamp, ".")
	if !ok || subtle.ConstantTimeCompare([]byte(sv.App.Mac("bot:"+at)), []byte(mac)) != 1 {
		return "the form wasn't one this app showed"
	}
	ms, err := strconv.ParseInt(at, 36, 64)
	if err != nil {
		return "the form wasn't one this app showed"
	}
	switch age := time.Now().UnixMilli() - ms; {
	case age < botMinMS:
		return "it was sent faster than a person fills it in"
	case age > botMaxMS:
		return "the form was shown more than a day ago: load the page again"
	}
	return ""
}
