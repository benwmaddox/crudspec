package rt

// The UI: screens, components and layouts as element trees the generator emits, with every
// expression compiled to a function. The renderer below walks them as the TypeScript runtime
// walks the parsed spec (lang/runtime/server.ts), producing the same markup.

type Expr = func(c *Ctx) Val

type NamedExpr struct {
	Name string
	E    Expr
}

// a link's, button's, form's or go's target: a screen or action call, back, home, or url <expr>
type Target struct {
	URL   Expr // url <expr>
	Name  string
	Bare  bool
	Args  []Expr
	Named []NamedExpr
}

type Reaction struct {
	Kind   string // go, flash, sign_in_as, stay, clear, shake
	Target *Target
	Value  Expr
}

// a picker: a view call in a field's mentions or autocomplete attribute, its arguments by
// the view's parameters (nil where the call gives none)
type Pick struct {
	View string
	Args []Expr
}

type El struct {
	ID       int
	Name     string
	Head     Expr // an expression head (heading, text, if, …)
	T        *Target
	Attrs    map[string]Expr
	Flags    map[string]bool
	Children []*El
	Else     []*El

	// field
	FieldName, FieldKind string
	Pick                 *Pick
	Unfurl               string // a view name
	UnfurlParam          string
	// on
	Outcome   string
	Reactions []Reaction
	// list
	ListQuery  func(c *Ctx) []*Row // a query source
	ListEntity string
	ListPerm   func(c *Ctx, row Val) bool
	ListView   string
	ListArgs   []Expr // by the view's parameters
	Bind       string
	Where      Expr
	Order      Expr
	Desc       bool
	// each
	Over Expr
	// let
	LetName string
	// use, widget, channel, signal
	Call     string
	CallArgs []Expr
	ArgName  string // the first argument, when it is a bare name (push_permission's action)
	// time
	As string
}

func (el *El) Has(attr string) bool {
	if el.Flags[attr] {
		return true
	}
	_, ok := el.Attrs[attr]
	return ok
}

type ScreenReq struct {
	Cond    Expr
	Go      *Target
	Flash   Expr
	Outcome string
}

type Screen struct {
	Name     string
	Route    string
	Params   []Param
	Public   bool
	Remember string
	Requires []ScreenReq
	Body     []*El
}

type Component struct {
	Name   string
	Params []string
	Body   []*El
}

type Identity struct {
	Name   string
	Entity string
	Field  string
	Source string // cookie, param, token
	Key    string
	Format string
	Where  func(c *Ctx) bool // on the identity's row
}

type ChannelDecl struct {
	Name                string
	Open, Close, Every  string // actions
}

type APIRoute struct {
	Method, Path string
	Target       string
	Args         []Expr // by the target's parameters (nil where none)
	Status       int
	JSON         func(c *Ctx, v Val) Val
}
type APIDecl struct {
	Name, Route, Identity string
	Skips                 []string
	Routes                []APIRoute
}

type WidgetHelpers struct {
	Icon, Label, Cls string
	DC               func(kind string) string
	Display          func(r Ref) string
	FileURL          func(v Val) string
	Attr             func(name string) Val
}

type UI struct {
	Screens      []*Screen
	Components   map[string]*Component
	Theme        map[string]Expr // logo, custom, stylesheets, classes, tokens
	Displays     map[string]func(c *Ctx) Val
	Avatars      map[string]func(c *Ctx) Val
	Identities   []*Identity
	Channels     map[string]*ChannelDecl
	APIs         []*APIDecl
	AppName      string
	SignIn       string
	Setup        string
	SetupWhen    Expr
	Widgets      map[string]func(args []Val, h WidgetHelpers) string
	Declared     map[string]bool // the app's widget declarations
	Permissions  map[string]func(c *Ctx, row Val) bool
	Externs      map[string]string // name -> effect
	Elements     map[int]*El
	Descriptor   string                     // the agent descriptor (lang/describe.ts), as JSON
	Hidden       map[string]map[string]bool // fields that never leave the server
}
