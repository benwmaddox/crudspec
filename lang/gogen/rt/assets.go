package rt

// Static assets, versioned by content. An asset's URL carries a hash of its bytes
// (/assets/app.css?v=1a2b3c4d), so a page names exactly the file it was made with and the browser
// may keep it for good (immutable, a year); a URL without the current hash (an old page, a
// hand-written link) is kept 5 minutes and revalidated by ETag (304, nothing sent again). A text
// asset (CSS, JS, SVG, JSON, …) is gzipped once, at the best level, the first time it's needed,
// and sent so to a client that takes gzip. Hashes are worked out on first use and kept until the
// app restarts: assets are part of a deploy.

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type assetInfo struct {
	hash    string
	ctype   string
	raw, gz []byte // a text asset's bytes, and gzipped when that's smaller; nil for others (streamed)
}

var compressible = map[string]bool{".css": true, ".js": true, ".mjs": true, ".svg": true, ".json": true, ".txt": true, ".html": true, ".xml": true, ".map": true, ".webmanifest": true}

// assetVersion is the asset's hash (and, for text, its bytes and gzip), worked out once
func (sv *Server) assetVersion(full string) *assetInfo {
	if a, ok := sv.assetInfos.Load(full); ok {
		return a.(*assetInfo)
	}
	ct, ok := mimeTypes[filepath.Ext(full)]
	if !ok {
		ct = "application/octet-stream"
	}
	a := &assetInfo{ctype: ct}
	h := sha256.New()
	if compressible[strings.ToLower(filepath.Ext(full))] {
		raw, err := os.ReadFile(full)
		if err != nil {
			return nil
		}
		h.Write(raw)
		a.raw = raw
		var z bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&z, gzip.BestCompression)
		zw.Write(raw)
		zw.Close()
		if z.Len() < len(raw) {
			a.gz = z.Bytes()
		}
	} else {
		f, err := os.Open(full)
		if err != nil {
			return nil
		}
		io.Copy(h, f)
		f.Close()
	}
	a.hash = hex.EncodeToString(h.Sum(nil))[:12]
	got, _ := sv.assetInfos.LoadOrStore(full, a)
	return got.(*assetInfo)
}

// AssetURL is an asset's address with its content's hash, so the browser can keep it for good;
// an asset not found keeps its plain address (the request 404s, as before)
func (sv *Server) AssetURL(name string) string {
	if full := sv.findAsset(name); full != "" {
		if a := sv.assetVersion(full); a != nil {
			return "/assets/" + name + "?v=" + a.hash
		}
	}
	return "/assets/" + name
}

func (sv *Server) sendAsset(w http.ResponseWriter, r *HTTPReq, name string) {
	full := sv.findAsset(name)
	if full == "" || !isFile(full) {
		status(w, 404, "")
		return
	}
	a := sv.assetVersion(full)
	if a == nil {
		status(w, 404, "")
		return
	}
	h := w.Header()
	h.Set("Content-Type", a.ctype)
	h.Set("ETag", `"`+a.hash+`"`)
	h.Add("Vary", "Accept-Encoding")
	if r.Query.Get("v") == a.hash {
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		h.Set("Cache-Control", "max-age=300")
	}
	if inm := r.IfNoneMatch; inm != "" && (inm == "*" || strings.Contains(inm, `"`+a.hash+`"`)) {
		w.WriteHeader(304)
		return
	}
	switch {
	case a.gz != nil && r.Gzip:
		h.Set("Content-Encoding", "gzip")
		h.Set("Content-Length", strconv.Itoa(len(a.gz)))
		w.WriteHeader(200)
		w.Write(a.gz)
	case a.raw != nil:
		h.Set("Content-Length", strconv.Itoa(len(a.raw)))
		w.WriteHeader(200)
		w.Write(a.raw)
	default:
		f, err := os.Open(full)
		if err != nil {
			status(w, 404, "")
			return
		}
		defer f.Close()
		if st, err := f.Stat(); err == nil {
			h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
		}
		w.WriteHeader(200)
		io.Copy(w, f)
	}
}

