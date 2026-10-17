package rt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

// Web Push: the RFC 8291 appendix A vector, a round trip decrypted as a browser would, a
// VAPID signature that verifies, and the delivery outcomes.

func TestRFC8291Vector(t *testing.T) {
	priv, _ := b64u.DecodeString("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
	salt, _ := b64u.DecodeString("DGv6ra1nlYgDCS1FRnbzlw")
	got, err := encryptPushWith([]byte("When I grow up, I want to be a watermelon"),
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg", priv, salt)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if b64u.EncodeToString(got) != want {
		t.Fatalf("vector differs:\n%s", b64u.EncodeToString(got))
	}
}

func TestPushRoundTripAndVapid(t *testing.T) {
	ua, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := []byte("0123456789abcdef")
	sender, _ := ecdh.P256().GenerateKey(rand.Reader)
	v := &Vapid{PublicKey: b64u.EncodeToString(sender.PublicKey().Bytes()), PrivateKey: b64u.EncodeToString(sender.Bytes()), Subject: "mailto:test@example.invalid"}
	var body []byte
	var headers map[string]string
	pushPost = func(endpoint string, b []byte, h map[string]string) *guarded { body, headers = b, h; return &guarded{status: 201} }
	payload := map[string]any{"title": "Room", "options": map[string]any{"body": "Ada: hi", "data": map[string]any{"path": "/rooms/1", "badge": 2}}}
	if r := SendPush("https://fcm.googleapis.com/fcm/send/abc", b64u.EncodeToString(ua.PublicKey().Bytes()), b64u.EncodeToString(auth), payload, v); r != "sent" {
		t.Fatalf("201 gave %v", r)
	}
	// the browser's side
	salt, idlen := body[:16], int(body[20])
	asPub, ct := body[21:21+idlen], body[21+idlen:]
	asKey, _ := ecdh.P256().NewPublicKey(asPub)
	secret, _ := ua.ECDH(asKey)
	ikm := hmacSum(hmacSum(auth, secret), append(append(append([]byte("WebPush: info\x00"), ua.PublicKey().Bytes()...), asPub...), 1))
	prk := hmacSum(salt, ikm)
	block, _ := aes.NewCipher(hmacSum(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16])
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, hmacSum(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12], ct, nil)
	if err != nil || plain[len(plain)-1] != 2 || !strings.Contains(string(plain), `"/rooms/1"`) {
		t.Fatalf("payload didn't decrypt: %v", err)
	}
	if headers["Content-Encoding"] != "aes128gcm" || headers["TTL"] == "" || headers["Urgency"] != "high" {
		t.Fatalf("headers %v", headers)
	}
	// VAPID: the JWT verifies with k, for the push service's origin
	parts := strings.SplitN(strings.TrimPrefix(headers["Authorization"], "vapid t="), ", k=", 2)
	jwt := strings.Split(parts[0], ".")
	pub, _ := b64u.DecodeString(parts[1])
	key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(pub[1:33]), Y: new(big.Int).SetBytes(pub[33:])}
	sig, _ := b64u.DecodeString(jwt[2])
	h := sha256.Sum256([]byte(jwt[0] + "." + jwt[1]))
	if !ecdsa.Verify(key, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("VAPID signature doesn't verify")
	}
	var claims struct {
		Aud string
		Exp int64
	}
	cb, _ := b64u.DecodeString(jwt[1])
	json.Unmarshal(cb, &claims)
	if claims.Aud != "https://fcm.googleapis.com" || claims.Exp < time.Now().Unix() {
		t.Fatalf("claims %+v", claims)
	}
	pushPost = func(string, []byte, map[string]string) *guarded { return &guarded{status: 410} }
	if r := SendPush("https://fcm.googleapis.com/x", b64u.EncodeToString(ua.PublicKey().Bytes()), b64u.EncodeToString(auth), payload, v); r != "expired" {
		t.Fatalf("410 gave %v", r)
	}
	if r := SendPush("http://fcm.googleapis.com/x", "a", "b", payload, v); r != "failed" {
		t.Fatalf("http endpoint gave %v", r)
	}
}
