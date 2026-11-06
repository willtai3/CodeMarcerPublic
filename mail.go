package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Mailer sends one plain-text email. The site sends only edit links to engineers.
type Mailer interface {
	Send(to, subject, text string) error
}

// logMailer is for running locally: the email is printed to the server log instead of sent.
type logMailer struct{}

func (logMailer) Send(to, subject, text string) error {
	log.Printf("mail to %s: %s\n%s", to, subject, text)
	return nil
}

// acsMailer sends through Azure Communication Services Email, signed with the resource's access key (HMAC-SHA256),
// using only the standard library.
type acsMailer struct {
	endpoint *url.URL
	key      []byte
	from     string
	client   *http.Client
	now      func() time.Time
}

// newACS reads ACS_CONNECTION_STRING ("endpoint=https://….communication.azure.com/;accesskey=…").
func newACS(conn, from string) (*acsMailer, error) {
	var ep, key string
	for _, part := range strings.Split(conn, ";") {
		k, v, _ := strings.Cut(part, "=")
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "endpoint":
			ep = strings.TrimSpace(v)
		case "accesskey":
			key = strings.TrimSpace(v)
		}
	}
	u, err := url.Parse(ep)
	k, err2 := base64.StdEncoding.DecodeString(key)
	if err != nil || u.Scheme != "https" || u.Host == "" || err2 != nil || len(k) == 0 || !strings.Contains(from, "@") {
		return nil, errors.New("ACS_CONNECTION_STRING needs endpoint=https://… and accesskey=…, and MAIL_FROM an address")
	}
	return &acsMailer{endpoint: u, key: k, from: from, client: &http.Client{Timeout: 10 * time.Second}, now: time.Now}, nil
}

const acsPath = "/emails:send?api-version=2023-03-31"

func (m *acsMailer) Send(to, subject, text string) error {
	body, _ := json.Marshal(map[string]any{
		"senderAddress": m.from,
		"recipients":    map[string]any{"to": []map[string]string{{"address": to}}},
		"content":       map[string]string{"subject": subject, "plainText": text},
	})
	req, _ := http.NewRequest(http.MethodPost, strings.TrimRight(m.endpoint.String(), "/")+acsPath, bytes.NewReader(body))
	sum := sha256.Sum256(body)
	hash, date := base64.StdEncoding.EncodeToString(sum[:]), m.now().UTC().Format(http.TimeFormat)
	mac := hmac.New(sha256.New, m.key)
	mac.Write([]byte("POST\n" + acsPath + "\n" + date + ";" + m.endpoint.Host + ";" + hash))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-ms-date", date)
	req.Header.Set("x-ms-content-sha256", hash)
	req.Header.Set("Authorization", "HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature="+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	res, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 500))
		return fmt.Errorf("email service answered %d: %s", res.StatusCode, msg)
	}
	return nil
}

// editMail is the email with an engineer's private edit link.
func editMail(name, link string, fresh bool) (string, string) {
	first := "Your listing on CodeMarcer is live."
	if !fresh {
		first = "Here is a new link to edit your CodeMarcer listing. Older links no longer work."
	}
	return "Your CodeMarcer edit link", fmt.Sprintf("Hi %s,\n\n%s To change or remove it, open this private link:\n\n%s\n\nAnyone with this link can change your listing, so don't share it. To get a new one, use \"Email me my edit link\" on the For engineers tab.\n\nIf you didn't list yourself on CodeMarcer, you can ignore this email.\n", name, first, link)
}
