package rt

import (
	"net/url"
	"regexp"
	"sync/atomic"
)

// The UI: screens, components and layouts as element trees the generator emits, with every
// expression compiled to a function. The renderer below walks them as the TypeScript runtime
// walks the parsed spec (lang/runtime/server.ts), producing the same markup.

type Expr = func(c *Ctx) Val

const _ = 0

// a picker: a view call in a field's mentions or autocomplete attribute, its arguments by
// the view's parameters (nil where the call gives none)
type Pick struct {
	View string
	Args func(rc *RCtx) map[string]Val // the view's arguments, by parameter
}

// El is what a form post or a picker finds again by id: a handler, or a field with a picker.
type El struct {
	ID                   int
	Name                 string
	Flags                map[string]bool // the attributes the element has
	FieldName, FieldKind string
	Pick                 *Pick
	Unfurl               string // a view name
	UnfurlParam          string
	Outcome              string
	React                func(sv *Server, rc *RCtx, re *Reacted) // the handler, compiled
}

type Screen struct {
	Name          string
	Route         string
	Public        bool
	Remember      string
	RememberParam string
	Pattern       *regexp.Regexp // the route, compiled
	Names         []string
	Coerce        func(sp map[string]string, q url.Values, s *Sess) map[string]Val
	Guard         func(sv *Server, rc *RCtx) Guarded  // the screen's requires
	Render        func(sv *Server, rc *RCtx) string   // the compiled screen: its redirect, if any
	File          func(sv *Server, rc *RCtx) Download // an export: the file, instead of a page (export.go)
	learned       atomic.Int64                        // the size its pages come to (a running average)
}

type Guarded struct {
	Refused bool
	To      string
	Cookies []string
	Outcome string
}

type Identity struct {
	Name    string
	Entity  string
	Field   string
	Source  string // cookie, param, token
	Key     string
	Format  string
	Where   func(c *Ctx) bool            // on the identity's row (agents recheck it)
	Resolve func(c *Ctx, raw string) Val // a parameter identity: the row its value names
}

type ChannelCall struct {
	Action string
	Args   func(parts []string) map[string]Val
}
type ChannelDecl struct {
	Name               string
	Open, Close, Every *ChannelCall
}

type APIRoute struct {
	Method, Path string
	Target       string
	Vars         func(p map[string]string) map[string]Val // path parameters, typed
	Args         func(rc *RCtx) map[string]Val            // the target's arguments
	Status       int
	Pattern      *regexp.Regexp
	Names        []string
	JSON         func(c *Ctx, v Val) Val
}
type APIDecl struct {
	Name, Route, Identity string
	Ident                 *Identity
	Skips                 []string
	Routes                []APIRoute
}

type WidgetHelpers struct {
	Icon, Label, Cls string
	DC               func(kind string) string
	Display          func(r Ref) string
	FileURL          func(v Val) string
	Attr             func(name string) Val
	Asset            func(name string) string // an asset's address (with its version)
}

type UI struct {
	Screens       []*Screen
	Theme         map[string]Expr // logo, custom, stylesheets, classes, tokens
	Displays      map[string]func(c *Ctx) Val
	DefaultLabels map[string]func(row *Row) string // entities without a display: a name-like field
	Avatars       map[string]func(c *Ctx) Val
	Identities    []*Identity
	Channels      map[string]*ChannelDecl
	APIs          []*APIDecl
	AppName       string
	SignIn        string
	Setup         string
	SetupWhen     Expr
	Widgets       map[string]func(args []Val, h WidgetHelpers) string
	Declared      map[string]bool // the app's widget declarations
	Permissions   map[string]func(c *Ctx, row Val) bool
	SessionLookup func(c *Ctx, token string) Val           // the session identity: its actor, or none
	SessionToken  func(c *Ctx, session Ref) (string, bool) // a session row's token
	SessionReads  []string                                 // the entities the lookup reads ("*": anything), for its cache
	Externs       map[string]string                        // name -> effect
	Elements      map[int]*El
	Descriptor    string                                                      // the agent descriptor (lang/describe.ts), as JSON
	AgentArgs     map[string]func(given any) (map[string]Val, map[string]any) // each callable's arguments, checked
	AgentRedact   map[string][]string                                         // password parameters, never audited
}
