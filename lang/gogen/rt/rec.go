package rt



// A row's fields. A stored entity's are a generated struct of typed fields, scanned straight
// from its columns (the generator's R_<Entity>), so reading a row boxes nothing; Get boxes one
// field for the code that is dynamic by nature (agents' JSON, the test protocol, probes). Data
// entities, test loads and drafts hold the dynamic form, ValsRec.
type Rec interface {
	Get(i int) Val    // the field as a dynamic value
	Set(i int, v Val) // from a dynamic value
	Enc() []any       // the stored values, one per field (a Time's TimeCol, a File's FileCol, …)
	EncAt(i int) any  // one of them
	Bind(st *Stmt, at int) int // its columns, typed, from position at; the next position
	Keys(e string, d Deps) // the live-page keys of the values it holds (Sess.wrote's, typed)
}

// ValsRec is fields as dynamic values.
type ValsRec []Val

func (r ValsRec) Get(i int) Val {
	v := r[i]
	if raw, ok := v.(RawJSON); ok {
		v = FromJSON(string(raw))
		r[i] = v
	}
	return v
}
func (r ValsRec) Set(i int, v Val) { r[i] = v }
func (r ValsRec) EncAt(i int) any  { return r.Enc()[i] }
func (r ValsRec) Keys(e string, d Deps) {}
func (r ValsRec) Bind(st *Stmt, at int) int {
	for _, v := range r.Enc() {
		at = BindEnc(st, at, v)
	}
	return at
}
func (r ValsRec) Enc() []any      { panic("a ValsRec has no stored form: make the entity's own (Entity.NewRec)") }

// Vals is a row's fields as dynamic values, a copy.
func (r *Row) Vals(n int) []Val {
	out := make([]Val, n)
	for i := range out {
		out[i] = r.R.Get(i)
	}
	return out
}

// Set is a field from a dynamic value.
func (r *Row) Set(i int, v Val) { r.R.Set(i, v) }

// File is a stored file, as a File field holds it.
type File struct {
	Stored, Name, Type string
	Size               int64
}

func (f File) Val() Val {
	return Obj{"stored": f.Stored, "file": f.Name, "content_type": f.Type, "size": f.Size}
}
func FileOf(v Val) (File, bool) {
	o, ok := v.(Obj)
	if !ok || Plain(o["stored"]) == "" {
		return File{}, false
	}
	return File{Stored: Plain(o["stored"]), Name: Plain(o["file"]), Type: Plain(o["content_type"]), Size: Num(o["size"])}, true
}
func (f File) Col() FileCol { return FileCol{Stored: f.Stored, Name: f.Name, Type: f.Type, Size: f.Size} }

// Scanner is a generated function that reads one row of an entity's columns (id, seq, created,
// updated, then the fields') into a Row with its typed fields.
type Scanner func(st *Stmt) *Row

// ---- stored values from typed fields (a generated Rec's Enc)

// IDCol is a reference's column: its id, or NULL for none (0)
func IDCol(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

// OptCol is an optional value's column: the value, or NULL
func OptCol[T any](o Opt[T]) any {
	if !o.Ok {
		return nil
	}
	return o.V
}

func BoolCol(b bool) any {
	if b {
		return int64(1)
	}
	return int64(0)
}
func OptBoolCol(o Opt[bool]) any {
	if !o.Ok {
		return nil
	}
	return BoolCol(o.V)
}
func OptTimeCol(o Opt[Time]) any {
	if !o.Ok {
		return TimeCol{None: true}
	}
	return TimeCol{T: o.V.T, Seq: o.V.Seq}
}
func OptFileCol(o Opt[File]) any {
	if !o.Ok {
		return FileCol{None: true}
	}
	return o.V.Col()
}
// NullOr is a column's stored value: null when the field's column is NULL, else v
func NullOr(isNull bool, null, v any) any {
	if isNull {
		return null
	}
	return v
}
