package rt

import "testing"

// A read of a row nothing loaded (StrictLoads "refuse") stops the request; a row the request has
// (an identity-map hit), or one it was given (Inbound), is read.
func TestLoadedRefusesLazyReads(t *testing.T) {
	old := StrictLoads
	defer func() { StrictLoads = old }()
	StrictLoads = "refuse"
	e := &Entity{Name: "Note", Stored: true}
	s := &Sess{ident: map[rowKey]*Row{key("Note", 1): {ID: 1}}}
	if r := s.Loaded(e, 1); r == nil || r.ID != 1 {
		t.Fatalf("a loaded row: got %v", r)
	}
	func() {
		defer func() {
			if recover() == nil {
				t.Fatalf("a row nothing loaded was read")
			}
		}()
		s.Loaded(e, 2)
	}()
	if s.LazyLoads != 1 {
		t.Fatalf("lazy loads counted: %d", s.LazyLoads)
	}
}
