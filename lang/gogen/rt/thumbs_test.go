package rt

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"
)

func pngOf(w, h int, alpha uint8) []byte {
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 3; i < len(m.Pix); i += 4 {
		m.Pix[i-3], m.Pix[i] = 200, alpha
	}
	m.Set(0, 0, color.NRGBA{0, 0, 0, alpha})
	var b bytes.Buffer
	png.Encode(&b, m)
	return b.Bytes()
}

func TestThumbnails(t *testing.T) {
	fs := DirStore{Dir: t.TempDir()}
	fs.Put("big.png", pngOf(1000, 500, 255), "image/png")
	fs.Put("clear.png", pngOf(1000, 500, 100), "image/png")
	fs.Put("small.png", pngOf(150, 80, 255), "image/png")
	fs.Put("notes.txt", []byte("hello"), "text/plain")
	fs.Put("fake.png", []byte("not a png"), "image/png")

	if w := thumbWidth("250"); w != 400 {
		t.Fatalf("250 rounds to %d", w)
	}
	if w := thumbWidth("99999"); w != 1600 {
		t.Fatalf("99999 rounds to %d", w)
	}
	if w := thumbWidth("x"); w != 0 {
		t.Fatalf("x is %d", w)
	}

	k, err := thumbnail(fs, "big.png", 200)
	if err != nil || k != "big.png.w200.jpg" {
		t.Fatalf("big: %q %v", k, err)
	}
	b, _ := fs.Get(k)
	cfg, format, _ := image.DecodeConfig(bytes.NewReader(b))
	if format != "jpeg" || cfg.Width != 200 || cfg.Height != 100 {
		t.Fatalf("big thumbnail is %s %dx%d", format, cfg.Width, cfg.Height)
	}
	if k2, _ := thumbnail(fs, "big.png", 200); k2 != k { // kept, not made again
		t.Fatalf("second time: %q", k2)
	}
	if k, _ := thumbnail(fs, "clear.png", 400); !strings.HasSuffix(k, ".w400.png") {
		t.Fatalf("transparent: %q", k)
	}
	for _, key := range []string{"small.png", "notes.txt", "fake.png"} {
		if k, err := thumbnail(fs, key, 200); err != nil || k != key {
			t.Fatalf("%s: %q %v", key, k, err)
		}
	}
	if _, err := thumbnail(fs, "gone.png", 200); err != os.ErrNotExist {
		t.Fatalf("missing: %v", err)
	}
}
