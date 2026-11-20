package rt

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What the server did since it started, for an operator: requests by kind and by status, how long
// pages took, and how often the page cache answered. GET /_metrics, for administrators (the app's
// admin condition), as JSON. Requests are counted by kind (page, file, asset, action, agent,
// runtime), never by address, so nothing a request carried (a search, an email in a query) is kept.

type Metrics struct {
	mu          sync.Mutex
	start       time.Time
	kinds       map[string]int64
	statuses    map[int]int64
	cacheHits   int64
	cacheMisses int64
	pageMS      []float64 // the latest pages' times, at most pageWindow
	pageNext    int
}

const pageWindow = 2000

func NewMetrics() *Metrics {
	return &Metrics{start: time.Now(), kinds: map[string]int64{}, statuses: map[int]int64{}}
}

// requestKind: what a request was, by the shape of its path alone
func requestKind(method, path string) string {
	switch {
	case strings.HasPrefix(path, "/assets/"), strings.HasPrefix(path, "/_el/"):
		return "asset"
	case strings.HasPrefix(path, "/files/"), strings.HasPrefix(path, "/avatars/"):
		return "file"
	case strings.HasPrefix(path, "/_agent"), path == "/_mcp", path == "/llms.txt":
		return "agent"
	case strings.HasPrefix(path, "/_do/"), method == "POST":
		return "action"
	case strings.HasPrefix(path, "/_"), path == "/up", path == "/service-worker.js":
		return "runtime"
	}
	return "page"
}

func (m *Metrics) record(method, path string, status int, took time.Duration, cacheable, hit bool) {
	kind := requestKind(method, path)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.kinds[kind]++
	m.statuses[status]++
	if kind == "page" && status == 200 {
		ms := float64(took.Microseconds()) / 1000
		if len(m.pageMS) < pageWindow {
			m.pageMS = append(m.pageMS, ms)
		} else {
			m.pageMS[m.pageNext] = ms
			m.pageNext = (m.pageNext + 1) % pageWindow
		}
	}
	if cacheable {
		if hit {
			m.cacheHits++
		} else {
			m.cacheMisses++
		}
	}
}

// Snapshot is /_metrics's answer
func (m *Metrics) Snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	times := append([]float64(nil), m.pageMS...)
	sort.Float64s(times)
	pct := func(p float64) float64 {
		if len(times) == 0 {
			return 0
		}
		return times[int(p*float64(len(times)-1))]
	}
	statuses := map[string]int64{}
	var total int64
	for code, n := range m.statuses {
		statuses[strconv.Itoa(code)] = n
		total += n
	}
	rate := 0.0
	if m.cacheHits+m.cacheMisses > 0 {
		rate = float64(m.cacheHits) / float64(m.cacheHits+m.cacheMisses)
	}
	return map[string]any{
		"since":           m.start.UTC().Format(time.RFC3339),
		"seconds":         int64(time.Since(m.start).Seconds()),
		"requests":        total,
		"by_kind":         m.kinds,
		"by_status":       statuses,
		"page_ms":         map[string]float64{"p50": pct(0.5), "p95": pct(0.95), "max": pct(1)},
		"page_ms_of":      len(times),
		"page_cache_hits": m.cacheHits,
		"page_cache_miss": m.cacheMisses,
		"page_cache_rate": rate,
	}
}

// statusWriter: a response's status, as it's written
type statusWriter struct {
	http.ResponseWriter
	code int
}

func (s *statusWriter) WriteHeader(code int) {
	s.code = code
	s.ResponseWriter.WriteHeader(code)
}
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// health: the database answers a read. GET /up: 200 ok, or 503 when it doesn't; never cached.
func (sv *Server) health(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	var one int
	if err := sv.App.DB.A.QueryRow(`SELECT 1`).Scan(&one); err != nil || one != 1 {
		status(w, 503, "the database doesn't answer")
		return
	}
	status(w, 200, "ok")
}

// metricsPage: /_metrics, for administrators; anyone else gets not found
func (sv *Server) metricsPage(w http.ResponseWriter, r *HTTPReq, who Who) {
	w.Header().Set("Cache-Control", "no-store")
	if sv.Agents == nil {
		status(w, 404, "")
		return
	}
	if _, ok := sv.Agents.isAdmin(r, who); !ok {
		status(w, 404, "")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	snap := sv.Metrics.Snapshot()
	pb, pn := sv.Pages.Size()
	fb, fn := sv.App.DB.Cache.Size()
	snap["page_cache"] = map[string]any{"bytes": pb, "pages": pn, "budget": pageCacheMax}
	snap["fragment_cache"] = map[string]any{"bytes": fb, "fragments": fn, "budget": fragCacheBytes}
	snap["cache_max_age_hours"] = CacheMaxAge.Hours()
	snap["memory_pressure"] = map[string]any{"times": Pressure.Times, "evicted": Pressure.Evicted, "heap_bytes": heapNow()}
	b, _ := json.MarshalIndent(snap, "", "  ")
	w.WriteHeader(200)
	w.Write(b)
}
