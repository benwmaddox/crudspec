package rt

import (
	"strings"
	"testing"
)

// starts_with(col, p) read as an index range (gen.ts): col >= p AND col < PrefixEnd(p) holds for
// exactly the texts that start with p, compared as SQLite compares text (bytes, as Go does).
func TestPrefixEnd(t *testing.T) {
	max := string(rune(0x10FFFF))
	prefixes := []string{"", "a", "damage", "damage/", "Damage/Cost", "é", "日本", "x" + max, max, max + max, "a퟿", "zz"}
	texts := []string{"", "a", "ab", "b", "damage", "damage/cost", "damage/", "damage0", "damagf", "Damage/Cost/x", "é", "éa", "f", "日本語", "日", "x" + max, "x" + max + "y", "y", max, max + "a", max + max, "a퟿", "a퟿b", "a", "zz", "zz" + max, "zza"}
	for _, p := range prefixes {
		end := PrefixEnd(p)
		for _, s := range texts {
			want := strings.HasPrefix(s, p)
			got := s >= p && s < end
			if got != want {
				t.Errorf("prefix %q, text %q: range says %v, starts_with %v (end %q)", p, s, got, want, end)
			}
		}
	}
}
