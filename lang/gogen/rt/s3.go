package rt

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

// S3Store keeps uploads in a bucket on an S3-compatible service, signing each request with
// AWS Signature Version 4 (Go's crypto/hmac and crypto/sha256; no SDK). Objects are private:
// the app reads them back and serves them itself, after its own checks, so the bucket needs
// no public access.
type S3Store struct {
	Endpoint, Region, Bucket, Prefix, AccessKey, SecretKey string
	VirtualHost                                            bool
	Client                                                 *http.Client
	now                                                    func() time.Time // tests
}

func (s *S3Store) Describe() string {
	return "S3 bucket " + s.Bucket + " at " + s.Endpoint + (map[bool]string{true: ", under " + s.Prefix}[s.Prefix != ""])
}

func (s *S3Store) objectURL(key string) (*url.URL, error) {
	u, err := url.Parse(s.Endpoint)
	if err != nil {
		return nil, err
	}
	obj := s.Prefix + key
	if s.VirtualHost {
		u.Host = s.Bucket + "." + u.Host
		u.Path = strings.TrimRight(u.Path, "/") + "/" + obj
	} else {
		u.Path = strings.TrimRight(u.Path, "/") + "/" + s.Bucket + "/" + obj
	}
	return u, nil
}

func (s *S3Store) client() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (s *S3Store) Put(key string, data []byte, contentType string) error {
	if !validKey(key) {
		return fmt.Errorf("bad file key %q", key)
	}
	u, err := s.objectURL(key)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest("PUT", u.String(), bytes.NewReader(data))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	s.sign(req, sha256Hex(data))
	resp, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("S3 PUT %s: %s %s", key, resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}

func (s *S3Store) Get(key string) ([]byte, error) {
	if !validKey(key) {
		return nil, os.ErrNotExist
	}
	u, err := s.objectURL(key)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequest("GET", u.String(), nil)
	s.sign(req, emptySHA256)
	resp, err := s.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, os.ErrNotExist
	}
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("S3 GET %s: %s %s", key, resp.Status, strings.TrimSpace(string(b)))
	}
	return readAll(resp.Body)
}

const emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func sha256Hex(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func hmacSHA256(key []byte, data string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(data))
	return m.Sum(nil)
}

// sign adds SigV4's headers: x-amz-date, x-amz-content-sha256 and Authorization. It signs
// host, x-amz-* and any range header the request has.
func (s *S3Store) sign(req *http.Request, payloadHash string) {
	now := time.Now
	if s.now != nil {
		now = s.now
	}
	t := now().UTC()
	amzDate := t.Format("20060102T150405Z")
	day := t.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)
	req.Header.Set("x-amz-content-sha256", payloadHash)

	headers := map[string]string{"host": req.URL.Host}
	for k, v := range req.Header {
		lk := strings.ToLower(k)
		if strings.HasPrefix(lk, "x-amz-") || lk == "range" || lk == "content-md5" {
			headers[lk] = strings.TrimSpace(strings.Join(v, ","))
		}
	}
	names := make([]string, 0, len(headers))
	for k := range headers {
		names = append(names, k)
	}
	sort.Strings(names)
	var canonHeaders strings.Builder
	for _, k := range names {
		canonHeaders.WriteString(k + ":" + headers[k] + "\n")
	}
	signed := strings.Join(names, ";")
	canonical := strings.Join([]string{req.Method, s3EscapePath(req.URL.Path), canonicalQuery(req.URL.Query()), canonHeaders.String(), signed, payloadHash}, "\n")
	scope := day + "/" + s.Region + "/s3/aws4_request"
	toSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + sha256Hex([]byte(canonical))
	k := hmacSHA256([]byte("AWS4"+s.SecretKey), day)
	k = hmacSHA256(k, s.Region)
	k = hmacSHA256(k, "s3")
	k = hmacSHA256(k, "aws4_request")
	sig := hex.EncodeToString(hmacSHA256(k, toSign))
	req.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.AccessKey+"/"+scope+", SignedHeaders="+signed+", Signature="+sig)
}

// S3's URI encoding: everything but unreserved characters, and / kept in a path
func s3Escape(s string, path bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if ('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || (path && c == '/') {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func s3EscapePath(p string) string {
	if p == "" {
		return "/"
	}
	return s3Escape(p, true)
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), q[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, s3Escape(k, false)+"="+s3Escape(v, false))
		}
	}
	return strings.Join(parts, "&")
}
