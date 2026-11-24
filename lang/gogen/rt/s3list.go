package rt

// What backups need of a bucket beyond the app's files: a file sent as it's read (a database
// can be larger than is worth holding in memory), the objects under the store's prefix, and
// deleting old ones.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// PutFile sends a file from disk as the object key, read twice: once for its hash (the request
// is signed with it), once as it's sent.
func (s *S3Store) PutFile(key, path, contentType string) error {
	if !validKey(key) {
		return fmt.Errorf("bad object key %q", key)
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	u, err := s.objectURL(key)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest("PUT", u.String(), f)
	req.ContentLength = n
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	s.sign(req, hex.EncodeToString(h.Sum(nil)))
	resp, err := s.uploadClient().Do(req)
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

// a large upload takes longer than the app's requests are allowed
func (s *S3Store) uploadClient() *http.Client {
	if s.Client != nil {
		return s.Client
	}
	return &http.Client{Timeout: 30 * time.Minute}
}

// S3Object is one object listed: its key (without the store's prefix) and when it was written.
type S3Object struct {
	Key      string
	Modified time.Time
}

// List gives every object under the store's prefix (ListObjectsV2, a page of 1000 at a time).
func (s *S3Store) List() ([]S3Object, error) {
	out := []S3Object{}
	token := ""
	for {
		q := url.Values{"list-type": {"2"}}
		if s.Prefix != "" {
			q.Set("prefix", s.Prefix)
		}
		if token != "" {
			q.Set("continuation-token", token)
		}
		u, err := url.Parse(s.Endpoint)
		if err != nil {
			return nil, err
		}
		if s.VirtualHost {
			u.Host = s.Bucket + "." + u.Host
			u.Path = strings.TrimRight(u.Path, "/") + "/"
		} else {
			u.Path = strings.TrimRight(u.Path, "/") + "/" + s.Bucket
		}
		u.RawQuery = canonicalQuery(q)
		req, _ := http.NewRequest("GET", u.String(), nil)
		s.sign(req, emptySHA256)
		resp, err := s.client().Do(req)
		if err != nil {
			return nil, err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			return nil, fmt.Errorf("S3 list %s: %s %s", s.Bucket, resp.Status, strings.TrimSpace(string(body[:min(len(body), 2048)])))
		}
		var page struct {
			Contents []struct {
				Key          string `xml:"Key"`
				LastModified string `xml:"LastModified"`
			} `xml:"Contents"`
			Truncated bool   `xml:"IsTruncated"`
			Next      string `xml:"NextContinuationToken"`
		}
		if err := xml.Unmarshal(body, &page); err != nil {
			return nil, fmt.Errorf("S3 list %s: %w", s.Bucket, err)
		}
		for _, c := range page.Contents {
			t, _ := time.Parse(time.RFC3339, c.LastModified)
			out = append(out, S3Object{Key: strings.TrimPrefix(c.Key, s.Prefix), Modified: t})
		}
		if !page.Truncated || page.Next == "" {
			return out, nil
		}
		token = page.Next
	}
}

// Delete removes the object key.
func (s *S3Store) Delete(key string) error {
	if !validKey(key) {
		return fmt.Errorf("bad object key %q", key)
	}
	u, err := s.objectURL(key)
	if err != nil {
		return err
	}
	req, _ := http.NewRequest("DELETE", u.String(), nil)
	s.sign(req, emptySHA256)
	resp, err := s.client().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 && resp.StatusCode != 404 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("S3 DELETE %s: %s %s", key, resp.Status, strings.TrimSpace(string(b)))
	}
	return nil
}
