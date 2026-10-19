package rt

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// BaseURL is the app's address for absolute links: the configured one (--base-url), so a
// request's Host header can't choose where mail links point; else the request's.
func (a *App) BaseURL(c *Ctx) string {
	if a.PublicBase != "" {
		return a.PublicBase
	}
	if c.Req != nil && c.Req.Base != "" {
		return c.Req.Base
	}
	return ""
}

var routeParam = regexp.MustCompile(`:(\w+)`)

func idOrText(v Val) string {
	if r, ok := v.(Ref); ok {
		return fmt.Sprint(r.ID)
	}
	if v == nil {
		return ""
	}
	return Plain(v)
}

// URLOf is url_of(…): a screen's or API route's address, or a file's.
func (a *App) URLOf(c *Ctx, v Val) Val {
	switch x := v.(type) {
	case ScreenRef:
		if f := a.URLsOf["screen:"+x.Name]; f != nil {
			return f(a.BaseURL(c), x.Args)
		}
		return ""
	case APIRef:
		if f := a.URLsOf["api:"+x.Name]; f != nil {
			return f(a.BaseURL(c), x.Args)
		}
		return ""
	case Obj:
		if f, ok := x["file"]; ok {
			return a.BaseURL(c) + "/files/" + Plain(f)
		}
	}
	return Plain(v)
}

var fileExt = map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "application/pdf": ".pdf"}

// StoreFile keeps bytes a workflow made (a webhook's attachment reply) as uploads are kept.
func (a *App) StoreFile(bytes Val, name, contentType string) Val {
	var buf []byte
	switch b := bytes.(type) {
	case []byte:
		buf = b
	case nil:
		buf = []byte{}
	default:
		buf = []byte(Plain(b))
	}
	ext := fileExt[contentType]
	stored := a.Token(16) + ext
	if a.FilesDir != "" {
		os.WriteFile(filepath.Join(a.FilesDir, stored), buf, 0o644)
	}
	return Obj{"file": name + ext, "stored": stored, "content_type": contentType, "size": int64(len(buf))}
}
