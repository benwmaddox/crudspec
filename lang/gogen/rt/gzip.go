package rt

// Compressed responses. A page is mostly fragments from the cache (frag.go), so each cached
// fragment keeps its own compressed form, made once, and a page is sent as the joined pieces:
// what the page wrote around its cached fragments is compressed afresh, the fragments' compressed
// forms are copied in. Each piece is a deflate stream flushed to a byte boundary (an empty stored
// block), so they join into one valid stream; the last piece closes it, and the gzip trailer's
// CRC is of the whole page. A piece is used only if the page's bytes there are the fragment's
// HTML exactly; otherwise those bytes are compressed with the rest, so a position lost in a copy
// costs speed, never correctness.

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"hash/crc32"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// a cached fragment's place in a page buffer
type pageSeg struct {
	buf *bytes.Buffer
	off int
	e   *cacheEntry
}

// gzipMin: smaller bodies go as they are (the header and trailer would outweigh the saving)
const gzipMin = 1024

// AcceptsGzip reads Accept-Encoding: gzip (or *) with a q above 0.
func AcceptsGzip(h string) bool {
	for _, part := range strings.Split(h, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "gzip" && name != "*" {
			continue
		}
		if q, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			if f, err := strconv.ParseFloat(q, 64); err == nil && f <= 0 {
				continue
			}
		}
		return true
	}
	return false
}

var fastWriters = sync.Pool{New: func() any { w, _ := flate.NewWriter(nil, flate.BestSpeed); return w }}
var goodWriters = sync.Pool{New: func() any { w, _ := flate.NewWriter(nil, flate.DefaultCompression); return w }}

// storedMax: a gap between cached fragments up to this size goes as a stored (uncompressed)
// deflate block: a few dozen bytes of markers don't compress, and a compressed block's Huffman
// tables and flush cost more than they'd save
const storedMax = 512

// stored appends p as stored blocks (the stream is at a byte boundary), the last one final if last
func stored(out *bytes.Buffer, p []byte, last bool) {
	for {
		n := len(p)
		if n > 65535 {
			n = 65535
		}
		final := byte(0)
		if last && n == len(p) {
			final = 1
		}
		out.Write([]byte{final, byte(n), byte(n >> 8), ^byte(n), ^byte(n >> 8)})
		out.Write(p[:n])
		p = p[n:]
		if len(p) == 0 {
			return
		}
	}
}

// deflate appends p to out as one piece: flushed to a byte boundary, or closed when last
func deflate(out *bytes.Buffer, p []byte, pool *sync.Pool, last bool) {
	if pool == &fastWriters && len(p) <= storedMax {
		stored(out, p, last)
		return
	}
	fw := pool.Get().(*flate.Writer)
	fw.Reset(out)
	fw.Write(p)
	if last {
		fw.Close()
	} else {
		fw.Flush()
	}
	pool.Put(fw)
}

// deflated is the entry's HTML compressed, as a piece to join: made once, on first use
func (e *cacheEntry) deflated() []byte {
	e.gzOnce.Do(func() {
		var b bytes.Buffer
		deflate(&b, e.html, &goodWriters, false)
		e.gz = b.Bytes()
	})
	return e.gz
}

var gzipHeader = []byte{0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff}

// Gzip is body compressed, with the given cached fragments' pieces used where they are.
func Gzip(body []byte, segs []pageSeg) []byte {
	out := bytes.NewBuffer(make([]byte, 0, len(body)/8+64))
	out.Write(gzipHeader)
	sort.Slice(segs, func(i, j int) bool { return segs[i].off < segs[j].off })
	pos := 0
	for _, s := range segs {
		end := s.off + len(s.e.html)
		if s.off < pos || end > len(body) || !bytes.Equal(body[s.off:end], s.e.html) {
			continue // overlapping, or not what the page holds there: compressed with the rest
		}
		if s.off > pos {
			deflate(out, body[pos:s.off], &fastWriters, false)
		}
		out.Write(s.e.deflated())
		pos = end
	}
	deflate(out, body[pos:], &fastWriters, true)
	var tail [8]byte
	binary.LittleEndian.PutUint32(tail[:4], crc32.ChecksumIEEE(body))
	binary.LittleEndian.PutUint32(tail[4:], uint32(len(body)))
	out.Write(tail[:])
	return out.Bytes()
}

// writeBody sends a response body, compressed when the client takes gzip and it's worth it.
func writeBody(w http.ResponseWriter, r *HTTPReq, code int, body []byte, segs []pageSeg) {
	body, gz := encodeBody(r, body, segs)
	writeEncoded(w, code, body, gz)
}

// encodeBody is a response body as it is sent: gzipped when the client takes it and it is big
// enough to gain.
func encodeBody(r *HTTPReq, body []byte, segs []pageSeg) ([]byte, bool) {
	if r != nil && r.Gzip && len(body) >= gzipMin && !GzipOff {
		return Gzip(body, segs), true
	}
	return body, false
}

func writeEncoded(w http.ResponseWriter, code int, body []byte, gz bool) {
	h := w.Header()
	h.Add("Vary", "Accept-Encoding")
	if gz {
		h.Set("Content-Encoding", "gzip")
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(code)
	w.Write(body)
}

// GzipOff turns compression off (--no-gzip): for measuring, and for a proxy that compresses.
var GzipOff bool
