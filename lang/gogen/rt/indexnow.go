package rt

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// IndexNow: tells search engines (Bing, Yandex and others, through api.indexnow.org) which
// addresses are new or changed, so they needn't wait to crawl. It's on when CRUDSPEC_INDEXNOW_KEY
// is set (8 to 128 letters, digits and dashes) and the app knows its address (--base-url):
//   - the key is served at /<key>.txt, which is how IndexNow checks the site is the sender's;
//   - every pass (CRUDSPEC_INDEXNOW_EVERY seconds, 600 by default) reads the app's own sitemaps
//     as a signed-out visitor does (an index's sitemaps too, on the same address), and sends the
//     addresses that are new or whose lastmod changed since the last pass it sent;
//   - what was sent is kept in the database (crudspec_indexnow), so a restart doesn't send it all
//     again; a refused or failed send is tried again on the next pass.
// CRUDSPEC_INDEXNOW_ENDPOINT changes where it sends. In --test, nothing is sent and no pass runs
// by itself: POST /_test/indexnow runs one and lists what it would have sent.

const indexNowTable = `CREATE TABLE IF NOT EXISTS crudspec_indexnow (url TEXT PRIMARY KEY, lastmod TEXT NOT NULL) STRICT`

var indexNowKeyRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,128}$`)

// IndexNowKey is the key when IndexNow is on (none otherwise); the server serves /<key>.txt.
var IndexNowKey string

type sitemapEntry struct {
	Loc     string `xml:"loc"`
	Lastmod string `xml:"lastmod"`
}

type sitemapXML struct {
	URLs     []sitemapEntry `xml:"url"`
	Sitemaps []sitemapEntry `xml:"sitemap"`
}

// the configuration a pass uses, set when IndexNow turns on
var indexNowLocal, indexNowEndpoint string

// IndexNowSent: in --test, what passes would have sent (a list of address lists)
var IndexNowSent [][]string

// runIndexNow starts the passes, when the configuration asks for them.
func (sv *Server) runIndexNow(port int) {
	key := strings.TrimSpace(os.Getenv("CRUDSPEC_INDEXNOW_KEY"))
	if key == "" {
		return
	}
	if !indexNowKeyRe.MatchString(key) {
		fmt.Fprintln(os.Stderr, "indexnow: CRUDSPEC_INDEXNOW_KEY is 8 to 128 letters, digits and dashes; IndexNow is off")
		return
	}
	if sv.App.PublicBase == "" || len(Sitemaps) == 0 {
		fmt.Fprintln(os.Stderr, "indexnow: needs --base-url and a sitemap at a fixed address; IndexNow is off")
		return
	}
	IndexNowKey = key
	endpoint := os.Getenv("CRUDSPEC_INDEXNOW_ENDPOINT")
	if endpoint == "" && !sv.Test {
		endpoint = "https://api.indexnow.org/indexnow"
	}
	every := 600
	if s, err := strconv.Atoi(os.Getenv("CRUDSPEC_INDEXNOW_EVERY")); err == nil && s > 0 {
		every = s
	}
	local := "http://127.0.0.1:" + strconv.Itoa(port)
	indexNowLocal, indexNowEndpoint = local, endpoint
	if sv.Test {
		return // a test runs passes itself (POST /_test/indexnow)
	}
	go func() {
		time.Sleep(time.Duration(min(every, 30)) * time.Second) // the server is listening by then
		for {
			sv.indexNowPass(local, endpoint, key)
			time.Sleep(time.Duration(every) * time.Second)
		}
	}()
}

// indexNowPass reads the sitemaps and sends what's new or changed; it says what it did in one line.
func (sv *Server) indexNowPass(local, endpoint, key string) {
	base := sv.App.PublicBase
	client := &http.Client{Timeout: 30 * time.Second}
	get := func(path string) (sitemapXML, bool) {
		var m sitemapXML
		resp, err := client.Get(local + path)
		if err != nil {
			return m, false
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return m, false
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		return m, xml.Unmarshal(b, &m) == nil
	}
	found := map[string]string{} // address → lastmod
	seen := map[string]bool{}
	queue := append([]string{}, Sitemaps...)
	for len(queue) > 0 && len(seen) < 1000 {
		path := queue[0]
		queue = queue[1:]
		if seen[path] {
			continue
		}
		seen[path] = true
		m, ok := get(path)
		if !ok {
			continue
		}
		for _, s := range m.Sitemaps { // an index: its sitemaps, when they're on this site
			if strings.HasPrefix(s.Loc, base+"/") {
				queue = append(queue, strings.TrimPrefix(s.Loc, base))
			}
		}
		for _, u := range m.URLs {
			if strings.HasPrefix(u.Loc, base) {
				found[u.Loc] = u.Lastmod
			}
		}
	}
	if len(found) == 0 {
		return
	}
	// what changed since the last send
	a := sv.App
	a.DB.mu.Lock()
	a.DB.W.Exec(indexNowTable)
	sent := map[string]string{}
	if rows, err := a.DB.W.Query(`SELECT url, lastmod FROM crudspec_indexnow`); err == nil {
		for rows.Next() {
			var u, m string
			rows.Scan(&u, &m)
			sent[u] = m
		}
		rows.Close()
	}
	a.DB.mu.Unlock()
	var changed []string
	for u, m := range found {
		if old, ok := sent[u]; !ok || old != m {
			changed = append(changed, u)
		}
	}
	if len(changed) == 0 {
		return
	}
	host := base
	if p, err := url.Parse(base); err == nil {
		host = p.Host
	}
	for start := 0; start < len(changed); start += 10000 {
		batch := changed[start:min(start+10000, len(changed))]
		body, _ := json.Marshal(map[string]any{"host": host, "key": key, "keyLocation": base + "/" + key + ".txt", "urlList": batch})
		if endpoint == "" { // --test: kept, not sent
			IndexNowSent = append(IndexNowSent, batch)
			a.DB.mu.Lock()
			for _, u := range batch {
				a.DB.W.Exec(`INSERT INTO crudspec_indexnow (url, lastmod) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET lastmod = excluded.lastmod`, u, found[u])
			}
			a.DB.mu.Unlock()
			continue
		}
		req, _ := http.NewRequest("POST", endpoint, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json; charset=utf-8")
		resp, err := client.Do(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "indexnow: couldn't send %d addresses (%v); trying again next pass\n", len(batch), err)
			return
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 && resp.StatusCode != 202 {
			fmt.Fprintf(os.Stderr, "indexnow: %d addresses refused (%d); trying again next pass\n", len(batch), resp.StatusCode)
			return
		}
		a.DB.mu.Lock()
		for _, u := range batch {
			a.DB.W.Exec(`INSERT INTO crudspec_indexnow (url, lastmod) VALUES (?, ?) ON CONFLICT(url) DO UPDATE SET lastmod = excluded.lastmod`, u, found[u])
		}
		a.DB.mu.Unlock()
		fmt.Printf("indexnow: sent %d new or changed addresses (%d)\n", len(batch), resp.StatusCode)
	}
}

// indexNowKeyFile serves /<key>.txt: the key itself, which IndexNow fetches to check the sender.
func indexNowKeyFile(w http.ResponseWriter, path string) bool {
	if IndexNowKey == "" || path != "/"+IndexNowKey+".txt" {
		return false
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(200)
	io.WriteString(w, IndexNowKey)
	return true
}
