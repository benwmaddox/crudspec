package rt

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Uploads are kept in a FileStore by their stored key (random, with the upload's extension):
// a folder on this machine (the data directory's files/, the default) or a bucket on an
// S3-compatible service (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …). Either way the app
// serves them at /files/<key>, so pages, permissions and headers are the same.
type FileStore interface {
	Put(key string, data []byte, contentType string) error
	// Get gives the file's bytes; os.ErrNotExist when there is none
	Get(key string) ([]byte, error)
	Describe() string
}

// errStorage: the store refused an upload; the request fails (503) rather than keeping a
// row whose file isn't there
var errStorage = errors.New("file storage unavailable")

// a key is what the app made it: no path separators, no dot files
func validKey(key string) bool {
	return key != "" && !strings.ContainsAny(key, `/\`) && !strings.HasPrefix(key, ".") && len(key) <= 200
}

type DirStore struct{ Dir string }

func (d DirStore) Put(key string, data []byte, _ string) error {
	if !validKey(key) {
		return fmt.Errorf("bad file key %q", key)
	}
	tmp := filepath.Join(d.Dir, "."+key+".tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(d.Dir, key))
}

func (d DirStore) Get(key string) ([]byte, error) {
	if !validKey(key) {
		return nil, os.ErrNotExist
	}
	p := filepath.Join(d.Dir, key)
	if !isFile(p) {
		return nil, os.ErrNotExist
	}
	return os.ReadFile(p)
}

func (d DirStore) Describe() string { return "files in " + d.Dir }

// FileStoreFromEnv: S3 when CRUDSPEC_S3_BUCKET is set, else the data directory's files/.
//
//	CRUDSPEC_S3_BUCKET             the bucket
//	CRUDSPEC_S3_ENDPOINT           the service's address (https://s3.us-east-1.amazonaws.com,
//	                               https://<account>.r2.cloudflarestorage.com, http://localhost:9000);
//	                               AWS's for the region when not set
//	CRUDSPEC_S3_REGION             us-east-1 when not set ("auto" for R2)
//	CRUDSPEC_S3_ACCESS_KEY_ID      the key (or AWS_ACCESS_KEY_ID)
//	CRUDSPEC_S3_SECRET_ACCESS_KEY  its secret (or AWS_SECRET_ACCESS_KEY)
//	CRUDSPEC_S3_PREFIX             a folder in the bucket for this app's files ("wiki/")
//	CRUDSPEC_S3_VIRTUAL_HOST=1     bucket.endpoint addresses instead of endpoint/bucket
func FileStoreFromEnv(dir string) (FileStore, error) {
	bucket := os.Getenv("CRUDSPEC_S3_BUCKET")
	if bucket == "" {
		return DirStore{Dir: dir}, nil
	}
	env := func(k, alt string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return os.Getenv(alt)
	}
	s := &S3Store{
		Bucket:      bucket,
		Endpoint:    strings.TrimRight(os.Getenv("CRUDSPEC_S3_ENDPOINT"), "/"),
		Region:      os.Getenv("CRUDSPEC_S3_REGION"),
		AccessKey:   env("CRUDSPEC_S3_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
		SecretKey:   env("CRUDSPEC_S3_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"),
		Prefix:      os.Getenv("CRUDSPEC_S3_PREFIX"),
		VirtualHost: os.Getenv("CRUDSPEC_S3_VIRTUAL_HOST") == "1",
	}
	if s.Region == "" {
		s.Region = "us-east-1"
	}
	if s.Endpoint == "" {
		s.Endpoint = "https://s3." + s.Region + ".amazonaws.com"
	}
	if s.AccessKey == "" || s.SecretKey == "" {
		return nil, errors.New("CRUDSPEC_S3_BUCKET is set, but CRUDSPEC_S3_ACCESS_KEY_ID and CRUDSPEC_S3_SECRET_ACCESS_KEY aren't")
	}
	if !strings.HasPrefix(s.Endpoint, "http://") && !strings.HasPrefix(s.Endpoint, "https://") {
		return nil, fmt.Errorf("CRUDSPEC_S3_ENDPOINT %q isn't an http(s) address", s.Endpoint)
	}
	return s, nil
}

// readAll for a store's reader, bounded as uploads are
func readAll(r io.Reader) ([]byte, error) {
	var b bytes.Buffer
	_, err := io.Copy(&b, io.LimitReader(r, maxBody+1))
	return b.Bytes(), err
}
