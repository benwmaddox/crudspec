package rt

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/mail"
	"net/smtp"
	"os"
	"strings"
	"sync"
	"time"
)

// Mail: `send mail { to, subject, text, unsubscribe }` writes a message to the outbox in the
// statement's transaction, so a rolled-back action (a refusal, an agent's dry run) sends
// nothing, and a schedule's mail commits with its run. A dispatcher in the server delivers
// what's pending over SMTP and retries what fails; offline, nothing is delivered, and
// /_test/outbox shows what would have been.
//
// Configuration: CRUDSPEC_SMTP (host:port), CRUDSPEC_MAIL_FROM (an address), optionally
// CRUDSPEC_SMTP_USER and CRUDSPEC_SMTP_PASSWORD (sign-in, which net/smtp allows only over TLS
// or to localhost). The password is never logged.

const outboxTable = `CREATE TABLE IF NOT EXISTS crudspec_outbox (id INTEGER PRIMARY KEY, created INTEGER NOT NULL, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, unsubscribe TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT, sent_at INTEGER) STRICT`

const (
	maxSubject  = 998    // a header line's limit
	maxMailText = 200000 // characters
	maxTries    = 6
)

// SendMail queues a message; a bad address or a subject with a line break is refused (invalid).
func (c *Ctx) SendMail(to, subject, text, unsubscribe Val) {
	addr, err := mail.ParseAddress(Plain(to))
	if err != nil {
		Refuse("invalid", "send mail: not an address: "+Plain(to), "mail")
	}
	subj := Plain(subject)
	if strings.ContainsAny(subj, "\r\n") {
		Refuse("invalid", "send mail: the subject has a line break", "mail")
	}
	if len(subj) > maxSubject {
		Refuse("invalid", "send mail: the subject is too long", "mail")
	}
	body := Plain(text)
	if len([]rune(body)) > maxMailText {
		Refuse("invalid", "send mail: the text is too long", "mail")
	}
	var unsub any
	if u := Plain(unsubscribe); u != "" {
		if strings.ContainsAny(u, "\r\n<>") {
			Refuse("invalid", "send mail: the unsubscribe link isn't an address", "mail")
		}
		unsub = u
	}
	s := c.S
	s.mustWrite()
	s.execRaw(outboxTable)
	now := c.Now()
	s.mustExec(`INSERT INTO crudspec_outbox (created, to_addr, subject, body, unsubscribe, status, next_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`, now, addr.Address, subj, body, unsub, now)
}

// Mailer delivers one message; SMTP below, or another (the extension seam).
type Mailer interface {
	Deliver(from string, m OutMail) error
}

type OutMail struct {
	ID                             int64
	To, Subject, Body, Unsubscribe string
}

type smtpMailer struct {
	addr, user, password string
}

func (sm smtpMailer) Deliver(from string, m OutMail) error {
	var auth smtp.Auth
	if sm.user != "" {
		host, _, _ := net.SplitHostPort(sm.addr)
		auth = smtp.PlainAuth("", sm.user, sm.password, host)
	}
	return smtp.SendMail(sm.addr, auth, from, []string{m.To}, message(from, m))
}

// message is the RFC 5322 message: encoded subject, quoted-printable UTF-8 text, and a
// one-click unsubscribe when the mail has a link for it.
func message(from string, m OutMail) []byte {
	var b bytes.Buffer
	id := make([]byte, 12)
	rand.Read(id)
	host := "crudspec"
	if at := strings.LastIndex(from, "@"); at >= 0 {
		host = from[at+1:]
	}
	h := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	h("From", (&mail.Address{Address: from}).String())
	h("To", (&mail.Address{Address: m.To}).String())
	h("Subject", mime.QEncoding.Encode("utf-8", m.Subject))
	h("Date", time.Now().UTC().Format(time.RFC1123Z))
	h("Message-ID", "<"+hex.EncodeToString(id)+"@"+host+">")
	if m.Unsubscribe != "" {
		h("List-Unsubscribe", "<"+m.Unsubscribe+">")
		h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
	}
	h("MIME-Version", "1.0")
	h("Content-Type", "text/plain; charset=utf-8")
	h("Content-Transfer-Encoding", "quoted-printable")
	b.WriteString("\r\n")
	w := quotedprintable.NewWriter(&b)
	w.Write([]byte(strings.ReplaceAll(m.Body, "\n", "\r\n")))
	w.Close()
	return b.Bytes()
}

// MailConfig is the dispatcher's: where mail goes, and from whom.
type MailConfig struct {
	From    string
	Mailer  Mailer // none: nothing is delivered (offline, or a test without a mail server)
	Offline bool
}

// MailFromEnv reads the configuration; ok is false when the app sends mail and can't deliver.
func MailFromEnv(offline bool) (MailConfig, error) {
	cfg := MailConfig{From: os.Getenv("CRUDSPEC_MAIL_FROM"), Offline: offline}
	addr := os.Getenv("CRUDSPEC_SMTP")
	if offline || addr == "" {
		return cfg, nil
	}
	if _, err := mail.ParseAddress(cfg.From); err != nil {
		return cfg, fmt.Errorf("CRUDSPEC_MAIL_FROM must be an address to send mail from")
	}
	cfg.Mailer = smtpMailer{addr: addr, user: os.Getenv("CRUDSPEC_SMTP_USER"), password: os.Getenv("CRUDSPEC_SMTP_PASSWORD")}
	return cfg, nil
}

var mailMu sync.Mutex // one delivery pass at a time

// DeliverMail sends what's due in the outbox, at most a batch; a failure is retried later
// (1, 2, 4 … minutes), and after maxTries the message is marked failed.
func (a *App) DeliverMail(cfg MailConfig) int {
	if cfg.Mailer == nil {
		return 0
	}
	mailMu.Lock()
	defer mailMu.Unlock()
	now := a.Clock()
	a.DB.mu.Lock()
	a.DB.W.Exec(outboxTable)
	rows, err := a.DB.W.Query(`SELECT id, to_addr, subject, body, coalesce(unsubscribe, ''), attempts FROM crudspec_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY id LIMIT 50`, now)
	if err != nil {
		a.DB.mu.Unlock()
		return 0
	}
	type due struct {
		m        OutMail
		attempts int64
	}
	var list []due
	for rows.Next() {
		var d due
		rows.Scan(&d.m.ID, &d.m.To, &d.m.Subject, &d.m.Body, &d.m.Unsubscribe, &d.attempts)
		list = append(list, d)
	}
	rows.Close()
	a.DB.mu.Unlock()
	sent := 0
	for _, d := range list {
		err := cfg.Mailer.Deliver(cfg.From, d.m) // outside the writer: the network is slow
		a.DB.mu.Lock()
		if err == nil {
			a.DB.W.Exec(`UPDATE crudspec_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, last_error = NULL WHERE id = ?`, a.Clock(), d.m.ID)
			sent++
		} else {
			status, next := "pending", a.Clock()+int64(time.Minute/time.Millisecond)<<min(d.attempts, 10)
			if d.attempts+1 >= maxTries {
				status = "failed"
			}
			a.DB.W.Exec(`UPDATE crudspec_outbox SET status = ?, attempts = attempts + 1, next_at = ?, last_error = ? WHERE id = ?`, status, next, truncate(err.Error(), 500), d.m.ID)
			fmt.Fprintf(os.Stderr, "mail %d to %s: %v\n", d.m.ID, d.m.To, err)
		}
		a.DB.mu.Unlock()
	}
	return sent
}

// Outbox is the outbox's messages, newest first (/_test/outbox).
func (a *App) Outbox() []map[string]any {
	a.DB.mu.Lock()
	defer a.DB.mu.Unlock()
	a.DB.W.Exec(outboxTable)
	rows, err := a.DB.W.Query(`SELECT id, created, to_addr, subject, body, coalesce(unsubscribe, ''), status, attempts, coalesce(last_error, '') FROM crudspec_outbox ORDER BY id DESC LIMIT 500`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, created, attempts int64
		var to, subject, body, unsub, status, lastErr string
		rows.Scan(&id, &created, &to, &subject, &body, &unsub, &status, &attempts, &lastErr)
		out = append(out, map[string]any{"id": id, "created": created, "to": to, "subject": subject, "text": body, "unsubscribe": unsub, "status": status, "attempts": attempts, "error": lastErr})
	}
	return out
}

// runMail delivers every second while the server runs.
func (sv *Server) runMail() {
	if !sv.App.SendsMail || sv.Mail.Mailer == nil {
		return
	}
	go func() {
		for range time.Tick(time.Second) {
			sv.App.DeliverMail(sv.Mail)
		}
	}()
}
