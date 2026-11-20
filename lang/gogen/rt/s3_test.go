package rt

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// AWS's published example for Signature Version 4 with S3 ("Example: GET Object" in
// "Authenticating Requests: Using the Authorization Header"): the signature must match.
func TestS3SignatureAWSExample(t *testing.T) {
	s := &S3Store{Region: "us-east-1", AccessKey: "AKIAIOSFODNN7EXAMPLE", SecretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
		now: func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) }}
	req, _ := http.NewRequest("GET", "https://examplebucket.s3.amazonaws.com/test.txt", nil)
	req.Header.Set("Range", "bytes=0-9")
	s.sign(req, emptySHA256)
	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("Authorization\n got %s\nwant %s", got, want)
	}
}

// A store against a stand-in service: path-style addresses, the prefix, the body and its
// hash, and 404 as not existing.
func TestS3StoreRoundTrip(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 Credential=AK/") {
			w.WriteHeader(403)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case "PUT":
			b, _ := io.ReadAll(r.Body)
			if r.Header.Get("x-amz-content-sha256") != sha256Hex(b) {
				w.WriteHeader(400)
				return
			}
			objects[r.URL.Path] = b
		case "GET":
			b, ok := objects[r.URL.Path]
			if !ok {
				w.WriteHeader(404)
				return
			}
			w.Write(b)
		}
	}))
	defer srv.Close()
	s := &S3Store{Endpoint: srv.URL, Region: "auto", Bucket: "bkt", Prefix: "wiki/", AccessKey: "AK", SecretKey: "SK"}
	if err := s.Put("abc.png", []byte("png bytes"), "image/png"); err != nil {
		t.Fatal(err)
	}
	if _, ok := objects["/bkt/wiki/abc.png"]; !ok {
		t.Fatalf("stored at %v", objects)
	}
	b, err := s.Get("abc.png")
	if err != nil || string(b) != "png bytes" {
		t.Fatalf("got %q %v", b, err)
	}
	if _, err := s.Get("missing.png"); err != os.ErrNotExist {
		t.Fatalf("missing: %v", err)
	}
	if err := s.Put("../x", nil, ""); err == nil {
		t.Fatal("a key with a path was taken")
	}
}
