package rt

import (
	"bytes"
	"image"
	"strconv"
	"strings"
	"sync"
)

// Image sizes, so a page's <img>s carry width and height and the browser keeps their space before
// they load (no reflow). An uploaded image's size is worked out once, ever:
//   - at upload, its header is read (image.DecodeConfig: no pixels decoded) and the size kept beside
//     the file as "<key>.size" ("1920x1080");
//   - on render, sizes come from memory; after a restart, from that small file, not the image;
//   - an image uploaded before sizes were kept is read once, on first use, and its size file written.
// Not an image Go reads (or too large to): no size, and the <img> is written as before.

// ImageFiles is where uploads are kept, set when the server starts; none: no sizes
var ImageFiles func() FileStore

type imgSize struct{ w, h int }

var imgSizes sync.Map // stored key → imgSize ({0,0}: none)

// imageSize: an uploaded image's size, worked out once (see above)
func imageSize(key string) (int, int) {
	if v, ok := imgSizes.Load(key); ok {
		s := v.(imgSize)
		return s.w, s.h
	}
	s := imgSize{}
	if ImageFiles != nil && thumbable(key) && !strings.ContainsAny(key, "/\\") {
		fs := ImageFiles()
		if b, err := fs.Get(key + ".size"); err == nil {
			s = parseSize(string(b))
		} else if orig, err := fs.Get(key); err == nil {
			if cfg, _, err := image.DecodeConfig(bytes.NewReader(orig)); err == nil && cfg.Width > 0 && cfg.Height > 0 && cfg.Width*cfg.Height <= maxThumbPixels {
				s = imgSize{cfg.Width, cfg.Height}
				fs.Put(key+".size", []byte(strconv.Itoa(s.w)+"x"+strconv.Itoa(s.h)), "text/plain")
			}
		}
	}
	imgSizes.Store(key, s)
	return s.w, s.h
}

// rememberImageSize: at upload, the size from the bytes in hand (the header only), kept beside the file
func rememberImageSize(fs FileStore, key string, data []byte) {
	if !thumbable(key) {
		return
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxThumbPixels {
		imgSizes.Store(key, imgSize{})
		return
	}
	s := imgSize{cfg.Width, cfg.Height}
	imgSizes.Store(key, s)
	fs.Put(key+".size", []byte(strconv.Itoa(s.w)+"x"+strconv.Itoa(s.h)), "text/plain")
}

func parseSize(t string) imgSize {
	w, h, ok := strings.Cut(strings.TrimSpace(t), "x")
	if !ok {
		return imgSize{}
	}
	wi, e1 := strconv.Atoi(w)
	hi, e2 := strconv.Atoi(h)
	if e1 != nil || e2 != nil || wi <= 0 || hi <= 0 {
		return imgSize{}
	}
	return imgSize{wi, hi}
}

// shownSize: the size an image is shown at from /files/<key>?w=<n>: a thumbnail is never wider
// than the original, and keeps its shape
func shownSize(key string, thumb int) (int, int) {
	w, h := imageSize(key)
	if w == 0 {
		return 0, 0
	}
	if thumb > 0 && thumb < w {
		return thumb, (h*thumb + w/2) / w
	}
	return w, h
}

// fileSizeAttrs: ` width="…" height="…"` for an address of an upload (/files/<key>[?w=n]), or "" when
// it isn't one or its size isn't known
func fileSizeAttrs(src string) string {
	if !strings.HasPrefix(src, "/files/") {
		return ""
	}
	key, q, _ := strings.Cut(strings.TrimPrefix(src, "/files/"), "?")
	thumb := 0
	for _, p := range strings.Split(strings.ReplaceAll(q, "&amp;", "&"), "&") {
		if v, ok := strings.CutPrefix(p, "w="); ok {
			thumb = thumbWidth(v)
		}
	}
	w, h := shownSize(key, thumb)
	if w == 0 {
		return ""
	}
	return ` width="` + strconv.Itoa(w) + `" height="` + strconv.Itoa(h) + `"`
}

// withImageSizes adds width and height to the <img>s in rendered Markdown that show uploads and
// have none yet, and loading="lazy" (the browser fetches each as it nears the screen; no script).
// A scan, not a regexp: it runs over every page's HTML.
func withImageSizes(h string) string {
	if !strings.Contains(h, `<img src="/files/`) {
		return h
	}
	var b strings.Builder
	b.Grow(len(h) + 64)
	rest := h
	for {
		i := strings.Index(rest, `<img src="/files/`)
		if i < 0 {
			b.WriteString(rest)
			break
		}
		start := i + len(`<img src="`)
		end := strings.IndexByte(rest[start:], '"')
		if end < 0 {
			b.WriteString(rest)
			break
		}
		end += start
		tagEnd := strings.IndexByte(rest[end:], '>')
		b.WriteString(rest[:end+1])
		if tagEnd >= 0 && !strings.Contains(rest[end:end+tagEnd], "width=") {
			b.WriteString(fileSizeAttrs(rest[start:end]))
		}
		if tagEnd >= 0 && !strings.Contains(rest[end:end+tagEnd], "loading=") {
			b.WriteString(` loading="lazy" decoding="async"`) // the browser's own: fetched as it nears the screen
		}
		rest = rest[end+1:]
	}
	return b.String()
}
