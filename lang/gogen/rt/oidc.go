package rt

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Sign-in providers (docs: actions.md, "Sign-in providers"): `sign_in_provider google { issuer "…"
// then sign_in_with_google }` signs a person in with an OpenID Connect provider (Google, Microsoft,
// Okta, …). The client's id and secret come from the environment (CRUDSPEC_SIGN_IN_GOOGLE_CLIENT_ID,
// …_CLIENT_SECRET), never the spec.
//
//	GET /_sign_in/<name>[?return=/path]  to the provider, with a state, a nonce and a PKCE challenge
//	                                     kept in a signed cookie for ten minutes
//	GET /_sign_in/<name>/callback        the code exchanged for an ID token, which is checked (its
//	                                     signature by the provider's published keys, RS256 or ES256;
//	                                     issuer, audience, times, nonce); then the app's own action
//	                                     runs with email (only when the provider says it's verified),
//	                                     name and subject, and the session row it gives is signed in
//
// Every check uses Go's own crypto. A failure goes back to the sign-in screen with a flash.

// Provider is one sign_in_provider of the spec
type Provider struct {
	Name, Issuer, Then string
	Scopes             string // "openid email profile" when not said
}

type oidcMeta struct {
	Auth, Token, JWKS string
	at                time.Time
}

var (
	oidcMetas sync.Map // issuer -> *oidcMeta (an hour)
	oidcKeys  sync.Map // jwks url -> map[kid]crypto.PublicKey
)

func envName(provider, what string) string {
	return "CRUDSPEC_SIGN_IN_" + strings.ToUpper(provider) + "_" + what
}

// fetch: through the network guard (public addresses only), except a --test server's, whose
// provider is a stand-in on this machine
func (sv *Server) oidcFetch(link, method string, body []byte, headers map[string]string) (int, []byte, error) {
	if !sv.Test {
		g := guardedFetch(link, method, body, headers, 0)
		if g == nil {
			return 0, nil, errors.New("the provider couldn't be reached")
		}
		return g.status, g.body, nil
	}
	req, err := http.NewRequest(method, link, strings.NewReader(string(body)))
	if err != nil {
		return 0, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := (&http.Client{Timeout: 7 * time.Second}).Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, b, nil
}

func (sv *Server) oidcDiscover(p *Provider) (*oidcMeta, error) {
	if m, ok := oidcMetas.Load(p.Issuer); ok && time.Since(m.(*oidcMeta).at) < time.Hour {
		return m.(*oidcMeta), nil
	}
	st, b, err := sv.oidcFetch(strings.TrimSuffix(p.Issuer, "/")+"/.well-known/openid-configuration", "GET", nil, map[string]string{"Accept": "application/json"})
	if err != nil || st != 200 {
		return nil, fmt.Errorf("the provider's configuration couldn't be read (%d)", st)
	}
	var d struct {
		Issuer string `json:"issuer"`
		Auth   string `json:"authorization_endpoint"`
		Token  string `json:"token_endpoint"`
		JWKS   string `json:"jwks_uri"`
	}
	if json.Unmarshal(b, &d) != nil || d.Auth == "" || d.Token == "" || d.JWKS == "" || d.Issuer != p.Issuer {
		return nil, errors.New("the provider's configuration isn't for its issuer")
	}
	m := &oidcMeta{Auth: d.Auth, Token: d.Token, JWKS: d.JWKS, at: time.Now()}
	oidcMetas.Store(p.Issuer, m)
	return m, nil
}

func (sv *Server) oidcKey(m *oidcMeta, kid string) (crypto.PublicKey, error) {
	for try := 0; try < 2; try++ {
		if ks, ok := oidcKeys.Load(m.JWKS); ok && try == 0 {
			if k, ok := ks.(map[string]crypto.PublicKey)[kid]; ok {
				return k, nil
			}
			continue // a key it hasn't seen: the provider may have rotated them
		}
		st, b, err := sv.oidcFetch(m.JWKS, "GET", nil, map[string]string{"Accept": "application/json"})
		if err != nil || st != 200 {
			return nil, errors.New("the provider's keys couldn't be read")
		}
		var set struct {
			Keys []struct{ Kty, Kid, N, E, Crv, X, Y string } `json:"keys"`
		}
		if json.Unmarshal(b, &set) != nil {
			return nil, errors.New("the provider's keys aren't JSON")
		}
		keys := map[string]crypto.PublicKey{}
		for _, k := range set.Keys {
			switch {
			case k.Kty == "RSA":
				n, e1 := base64.RawURLEncoding.DecodeString(k.N)
				e, e2 := base64.RawURLEncoding.DecodeString(k.E)
				if e1 != nil || e2 != nil || len(e) > 4 {
					continue
				}
				if pub := (&rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}); pub.N.BitLen() >= 2048 {
					keys[k.Kid] = pub // (a shorter key isn't taken)
				}
			case k.Kty == "EC" && k.Crv == "P-256":
				x, e1 := base64.RawURLEncoding.DecodeString(k.X)
				y, e2 := base64.RawURLEncoding.DecodeString(k.Y)
				if e1 != nil || e2 != nil {
					continue
				}
				keys[k.Kid] = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
			}
		}
		oidcKeys.Store(m.JWKS, keys)
		if k, ok := keys[kid]; ok {
			return k, nil
		}
	}
	return nil, errors.New("the token is signed by a key the provider doesn't publish")
}

// oidcVerify checks an ID token and gives its claims
func (sv *Server) oidcVerify(p *Provider, m *oidcMeta, token, clientID, nonce string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("the ID token isn't one")
	}
	hb, e1 := base64.RawURLEncoding.DecodeString(parts[0])
	cb, e2 := base64.RawURLEncoding.DecodeString(parts[1])
	sig, e3 := base64.RawURLEncoding.DecodeString(parts[2])
	if e1 != nil || e2 != nil || e3 != nil {
		return nil, errors.New("the ID token isn't base64")
	}
	var head struct{ Alg, Kid string }
	if json.Unmarshal(hb, &head) != nil {
		return nil, errors.New("the ID token's header isn't JSON")
	}
	key, err := sv.oidcKey(m, head.Kid)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	switch k := key.(type) {
	case *rsa.PublicKey:
		if head.Alg != "RS256" || rsa.VerifyPKCS1v15(k, crypto.SHA256, digest[:], sig) != nil {
			return nil, errors.New("the ID token's signature doesn't hold")
		}
	case *ecdsa.PublicKey:
		if head.Alg != "ES256" || len(sig) != 64 || !ecdsa.Verify(k, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
			return nil, errors.New("the ID token's signature doesn't hold")
		}
	default:
		return nil, errors.New("the ID token is signed in a way that isn't taken")
	}
	var claims map[string]any
	if json.Unmarshal(cb, &claims) != nil {
		return nil, errors.New("the ID token's claims aren't JSON")
	}
	now := float64(sv.App.Clock()) / 1000
	num := func(k string) float64 { f, _ := claims[k].(float64); return f }
	aud := false
	switch a := claims["aud"].(type) {
	case string:
		aud = a == clientID
	case []any:
		for _, x := range a {
			aud = aud || x == clientID
		}
		if len(a) > 1 && claims["azp"] != clientID {
			aud = false
		}
	}
	switch {
	case claims["iss"] != p.Issuer:
		return nil, errors.New("the ID token is from another issuer")
	case !aud:
		return nil, errors.New("the ID token is for another app")
	case num("exp") < now-60:
		return nil, errors.New("the ID token has expired")
	case num("iat") > now+60:
		return nil, errors.New("the ID token is from the future")
	case claims["nonce"] != nonce:
		return nil, errors.New("the ID token isn't the one asked for")
	case Plain(claims["sub"]) == "":
		return nil, errors.New("the ID token names no one")
	}
	return claims, nil
}

func b64rand(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// signInWith answers /_sign_in/…: it is that path's
func (sv *Server) signInWith(w http.ResponseWriter, r *HTTPReq) {
	rest := strings.TrimPrefix(r.Path, "/_sign_in/")
	name, step, _ := strings.Cut(rest, "/")
	var p *Provider
	for i := range sv.UI.Providers {
		if sv.UI.Providers[i].Name == name {
			p = &sv.UI.Providers[i]
		}
	}
	if p == nil || (step != "" && step != "callback") || r.Method != "GET" {
		status(w, 404, "")
		return
	}
	clientID, secret := os.Getenv(envName(name, "CLIENT_ID")), os.Getenv(envName(name, "CLIENT_SECRET"))
	signInAt := "/"
	if s := sv.screenByName[sv.UI.SignIn]; s != nil {
		signInAt = s.Route
	}
	fail := func(why string) {
		fmt.Fprintf(os.Stderr, "sign in with %s: %s\n", name, why)
		redirect(w, signInAt, []string{flashCookie("Signing in with " + name + " didn't work: " + why + "."), "cs_sign_in=; Path=/_sign_in/; Max-Age=0"})
	}
	if clientID == "" || secret == "" {
		fail("it isn't set up on this server (" + envName(name, "CLIENT_ID") + ", " + envName(name, "CLIENT_SECRET") + ")")
		return
	}
	base := sv.App.PublicBase
	if base == "" {
		base = r.Base
	}
	callback := strings.TrimSuffix(base, "/") + "/_sign_in/" + name + "/callback"
	m, err := sv.oidcDiscover(p)
	if err != nil {
		fail(err.Error())
		return
	}
	secure := ""
	if r.Secure {
		secure = "; Secure"
	}
	if step == "" {
		ret := r.Query.Get("return")
		if !strings.HasPrefix(ret, "/") || strings.HasPrefix(ret, "//") || strings.HasPrefix(ret, "/\\") {
			ret = "/"
		}
		state, nonce, verifier := b64rand(24), b64rand(24), b64rand(48)
		exp := sv.App.Clock() + 10*60*1000
		body := strings.Join([]string{name, state, nonce, verifier, ret, fmt.Sprint(exp)}, "|")
		cookie := "cs_sign_in=" + base64.RawURLEncoding.EncodeToString([]byte(body)) + "." + sv.App.Mac(body) + "; Path=/_sign_in/; HttpOnly; SameSite=Lax; Max-Age=600" + secure
		challenge := sha256.Sum256([]byte(verifier))
		scopes := p.Scopes
		if scopes == "" {
			scopes = "openid email profile"
		}
		q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {callback}, "scope": {scopes}, "state": {state}, "nonce": {nonce},
			"code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
		sep := "?"
		if strings.Contains(m.Auth, "?") {
			sep = "&"
		}
		redirect(w, m.Auth+sep+q.Encode(), []string{cookie})
		return
	}
	// the callback: the cookie it set going says what to expect
	raw, ok := r.Cookies["cs_sign_in"]
	b64, mac, _ := strings.Cut(raw, ".")
	bb, err := base64.RawURLEncoding.DecodeString(b64)
	if !ok || err != nil || subtle.ConstantTimeCompare([]byte(sv.App.Mac(string(bb))), []byte(mac)) != 1 {
		fail("the sign-in had expired or was started elsewhere")
		return
	}
	f := strings.Split(string(bb), "|")
	exp, _ := strconv.ParseInt(f[len(f)-1], 10, 64)
	if len(f) != 6 || f[0] != name || exp < sv.App.Clock() {
		fail("the sign-in had expired")
		return
	}
	state, nonce, verifier, ret := f[1], f[2], f[3], f[4]
	if e := r.Query.Get("error"); e != "" {
		// an OAuth error code (access_denied, …): only its letters, and not long
		code := strings.Map(func(c rune) rune {
			if c == '_' || (c >= 'a' && c <= 'z') {
				return c
			}
			return -1
		}, e)
		if len(code) > 40 {
			code = code[:40]
		}
		fail("the provider said " + code)
		return
	}
	if r.Query.Get("state") != state || r.Query.Get("code") == "" {
		fail("the sign-in wasn't the one started here")
		return
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {r.Query.Get("code")}, "redirect_uri": {callback}, "client_id": {clientID}, "client_secret": {secret}, "code_verifier": {verifier}}
	st, tb, err := sv.oidcFetch(m.Token, "POST", []byte(form.Encode()), map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
	var tok struct {
		IDToken string `json:"id_token"`
	}
	if err != nil || st != 200 || json.Unmarshal(tb, &tok) != nil || tok.IDToken == "" {
		fail("the provider didn't give an ID token")
		return
	}
	claims, err := sv.oidcVerify(p, m, tok.IDToken, clientID, nonce)
	if err != nil {
		fail(err.Error())
		return
	}
	// the app's own action decides who this is: email only when the provider vouches for it
	args := map[string]Val{"subject": Plain(claims["sub"])}
	if v, _ := claims["email_verified"].(bool); v && Plain(claims["email"]) != "" {
		args["email"] = strings.ToLower(Plain(claims["email"]))
	}
	if n := Plain(claims["name"]); n != "" {
		args["name"] = n
	}
	req := &Request{IP: r.IP, UserAgent: r.UA, Method: "write", Base: r.Base, Host: HostName(r.Host)}
	out := sv.App.Run(r.Sess, p.Then, args, nil, req, nil)
	if out.Outcome != "ok" {
		fail("the app didn't take the account (" + out.Outcome + ")")
		return
	}
	ck := sv.sessionCookie(sv.plainCtx(r.Sess), out.Result, r.Secure)
	if ck == "" {
		fail("the app's action gave no session")
		return
	}
	redirect(w, ret, []string{ck, "cs_sign_in=; Path=/_sign_in/; Max-Age=0"})
}
