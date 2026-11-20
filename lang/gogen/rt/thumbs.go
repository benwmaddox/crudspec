package rt

import (
	"bytes"
	"errors"
	"image"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strconv"
	"strings"
	"sync"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// Thumbnails: /files/<key>?w=N is the image at most N pixels wide, made the first time it is
// asked for and kept in the file store beside the original (<key>.w<N>.jpg, or .png for an
// image with transparency). N is rounded up to one of ThumbWidths, so a page can't make the
// app keep a thumbnail for every width. An image already that narrow, or a file that isn't a
// PNG, JPEG, GIF or WebP, is served as it is. <Image thumb={N}> asks for one.
var ThumbWidths = []int{100, 200, 400, 800, 1600}

// thumbWidth: the width to make for a ?w= value, 0 for none
func thumbWidth(q string) int {
	n, err := strconv.Atoi(q)
	if err != nil || n <= 0 {
		return 0
	}
	for _, w := range ThumbWidths {
		if n <= w {
			return w
		}
	}
	return ThumbWidths[len(ThumbWidths)-1]
}

func thumbable(key string) bool {
	k := strings.ToLower(key)
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".gif", ".webp"} {
		if strings.HasSuffix(k, ext) {
			return true
		}
	}
	return false
}

// images larger than this aren't decoded (a small file can claim a huge size)
const maxThumbPixels = 60_000_000

var errNoThumb = errors.New("no thumbnail")

var thumbLocks sync.Map // key → *sync.Mutex: one maker per thumbnail

// thumbnail gives the stored key of the original's thumbnail at width w, making it if need be;
// the original's own key when it is that narrow already
func thumbnail(fs FileStore, key string, w int) (string, error) {
	if !thumbable(key) {
		return key, nil
	}
	for _, ext := range []string{".jpg", ".png"} {
		tk := key + ".w" + strconv.Itoa(w) + ext
		if _, err := fs.Get(tk); err == nil {
			return tk, nil
		}
	}
	mu, _ := thumbLocks.LoadOrStore(key+"@"+strconv.Itoa(w), &sync.Mutex{})
	mu.(*sync.Mutex).Lock()
	defer mu.(*sync.Mutex).Unlock()
	for _, ext := range []string{".jpg", ".png"} { // made while this waited
		tk := key + ".w" + strconv.Itoa(w) + ext
		if _, err := fs.Get(tk); err == nil {
			return tk, nil
		}
	}
	orig, err := fs.Get(key)
	if err != nil {
		return "", err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(orig))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxThumbPixels {
		return key, nil // not an image Go reads, or too large to: the original
	}
	if cfg.Width <= w {
		return key, nil
	}
	src, _, err := image.Decode(bytes.NewReader(orig))
	if err != nil {
		return key, nil
	}
	data, ext, err := resize(src, w)
	if err != nil {
		return "", err
	}
	tk := key + ".w" + strconv.Itoa(w) + ext
	ctype := map[string]string{".jpg": "image/jpeg", ".png": "image/png"}[ext]
	if err := fs.Put(tk, data, ctype); err != nil {
		return "", err
	}
	return tk, nil
}

// resize scales the image to width w, keeping its shape: a JPEG, or a PNG when it has
// transparency
func resize(src image.Image, w int) ([]byte, string, error) {
	b := src.Bounds()
	h := b.Dy() * w / b.Dx()
	if h < 1 {
		h = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	var out bytes.Buffer
	if opaque(dst) {
		if err := jpeg.Encode(&out, dst, &jpeg.Options{Quality: 82}); err != nil {
			return nil, "", err
		}
		return out.Bytes(), ".jpg", nil
	}
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&out, dst); err != nil {
		return nil, "", err
	}
	return out.Bytes(), ".png", nil
}

func opaque(m *image.RGBA) bool {
	for i := 3; i < len(m.Pix); i += 4 {
		if m.Pix[i] != 0xff {
			return false
		}
	}
	return true
}

var _ = gif.Decode // GIF's decoder registers itself with image
