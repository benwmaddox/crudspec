package rt

import (
	"bytes"
	"image"
	"image/png"
	"os"
	"strings"
	"testing"
	"time"
)

// a png of the size, as bytes
func sizedPNG(t *testing.T, w, h int) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// counts reads of the image itself (not its .size file)
type countingStore struct {
	DirStore
	imageReads int
}

func (c *countingStore) Get(key string) ([]byte, error) {
	if !strings.HasSuffix(key, ".size") {
		c.imageReads++
	}
	return c.DirStore.Get(key)
}

func TestImageSizesAreWorkedOutOnce(t *testing.T) {
	dir := t.TempDir()
	fs := &countingStore{DirStore: DirStore{Dir: dir}}
	ImageFiles = func() FileStore { return fs }
	defer func() { ImageFiles = nil }()

	// at upload: the size is kept beside the file, from the bytes in hand
	data := sizedPNG(t, 1600, 900)
	fs.Put("aaaa.png", data, "image/png")
	rememberImageSize(fs, "aaaa.png", data)
	if b, err := os.ReadFile(dir + "/aaaa.png.size"); err != nil || string(b) != "1600x900" {
		t.Fatalf("size file: %q %v", b, err)
	}
	html := withImageSizes(`<p><img src="/files/aaaa.png?w=800" alt="A"></p><img src="/files/aaaa.png" alt="">`)
	if !strings.Contains(html, `<img src="/files/aaaa.png?w=800" width="800" height="450" loading="lazy" decoding="async" alt="A">`) || !strings.Contains(html, `<img src="/files/aaaa.png" width="1600" height="900" loading="lazy" decoding="async" alt="">`) {
		t.Fatalf("sizes: %s", html)
	}
	if fs.imageReads != 0 {
		t.Fatalf("the image was read %d times; its size was known from the upload", fs.imageReads)
	}

	// an image from before sizes were kept: read once, its size file written, then from memory
	fs.Put("bbbb.png", sizedPNG(t, 300, 200), "image/png")
	for i := 0; i < 5; i++ {
		if w, h := shownSize("bbbb.png", 800); w != 300 || h != 200 {
			t.Fatalf("a thumbnail wider than the image keeps its size: %dx%d", w, h)
		}
	}
	if fs.imageReads != 1 {
		t.Fatalf("read %d times, want once", fs.imageReads)
	}
	// after a restart (memory empty): from the size file, not the image
	imgSizes.Delete("bbbb.png")
	if w, _ := shownSize("bbbb.png", 0); w != 300 || fs.imageReads != 1 {
		t.Fatalf("after a restart: width %d, image reads %d", w, fs.imageReads)
	}

	// not an upload, or not an image: left as it was
	if got := withImageSizes(`<img src="https://x.test/a.png" alt="">`); strings.Contains(got, "width=") {
		t.Fatalf("an outside image got a size: %s", got)
	}
	fs.Put("cccc.png", []byte("not a png"), "image/png")
	if got := withImageSizes(`<img src="/files/cccc.png" alt="">`); strings.Contains(got, "width=") {
		t.Fatalf("a broken image got a size: %s", got)
	}
	// an <img> that has a width already keeps it
	if got := withImageSizes(`<img src="/files/aaaa.png" width="10" alt="">`); strings.Count(got, "width=") != 1 {
		t.Fatalf("a given width was doubled: %s", got)
	}
}

func TestUnusedImageSizesAreLetGo(t *testing.T) {
	dir := t.TempDir()
	fs := &countingStore{DirStore: DirStore{Dir: dir}}
	ImageFiles = func() FileStore { return fs }
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	imgNow = func() time.Time { return now }
	defer func() { ImageFiles = nil; imgNow = time.Now }()

	data := sizedPNG(t, 64, 32)
	fs.Put("used.png", data, "image/png")
	fs.Put("idle.png", data, "image/png")
	rememberImageSize(fs, "used.png", data)
	rememberImageSize(fs, "idle.png", data)

	// 20 days on, one is shown again; 15 days after that, a sweep
	now = now.Add(20 * 24 * time.Hour)
	imageSize("used.png")
	now = now.Add(15 * 24 * time.Hour)
	sweepImageSizes()
	if _, ok := imgSizes.Load("used.png"); !ok {
		t.Fatal("a size used 15 days ago was let go")
	}
	if _, ok := imgSizes.Load("idle.png"); ok {
		t.Fatal("a size unused for 35 days is still in memory")
	}
	// shown again: from its small file, not the image
	if w, h := imageSize("idle.png"); w != 64 || h != 32 || fs.imageReads != 0 {
		t.Fatalf("back as %dx%d, with %d image reads", w, h, fs.imageReads)
	}
}
