package rt

import (
	"crypto/sha256"
	"encoding/hex"
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
	RowNames      []string // its address's parts that name a row (a required parameter of an entity): one that names none is not found
	Coerce        func(sp map[string]string, q url.Values, s *Sess) map[string]Val
	Guard         func(sv *Server, rc *RCtx) Guarded  // the screen's requires
	Render        func(sv *Server, rc *RCtx) string   // the compiled screen: its redirect, if any
	File          func(sv *Server, rc *RCtx) Download // an export: the file, instead of a page (export.go)
	Mask          map[string]uint64                   // the fields its render reads, by entity, a bit each (prune.go)
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
	EveryMS            int64 // how often the page calls Every (every 50 s), in milliseconds
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
	Extra        func(rc *RCtx) [][2]string // the headers it sends when the call succeeds (Location among them), with result bound
}
type APIDecl struct {
	Name, Route, Identity string
	Ident                 *Identity
	Skips                 []string
	Routes                []APIRoute
}

type UI struct {
	Screens       []*Screen
	Theme         map[string]Expr // logo, custom, stylesheets, classes, tokens
	Displays      map[string]func(c *Ctx) Val
	DefaultLabels map[string]func(row *Row) string // entities without a display: a name-like field
	Avatars       map[string]func(c *Ctx) Val
	Identities    []*Identity
	Channels      map[string]*ChannelDecl
	Signals       map[string]*SignalDecl // signal.go
	APIs          []*APIDecl
	AppName       string
	SignIn        string
	Setup         string
	SetupWhen     Expr
	Admin         Expr // app admin <condition>: an administrator (/_agents/all)
	AgentsWhen    Expr // agents_when: whether the agent interface answers
	AgentsAnon    Expr // agents_anonymous: whether views may be called without a token
	AgentCalls    Expr // agent_calls_per_minute
	AgentWrites   Expr // agent_writes_per_minute
	ElementScripts []ElementScript // the app's declared elements: their scripts (SetElements)
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

// ElementScript is a declared element's script (element my-tag(…) from "my-tag.js"), compiled
// into the app and served at Path: its content's hash is in the name, so a browser keeps it for
// good. Each page loads it as a module.
type ElementScript struct{ Tag, Body, Path string }

func (u *UI) SetElements(es []ElementScript) {
	for i := range es {
		h := sha256.Sum256([]byte(es[i].Body))
		es[i].Path = "/_el/" + es[i].Tag + "." + hex.EncodeToString(h[:6]) + ".js"
	}
	u.ElementScripts = es
}
