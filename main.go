// CodeMarcer server: one binary with the pages built in.
//
//	codemarcer          run the site (PORT, HOST, DATA_DIR, TRUST_PROXY)
//	codemarcer admin    create or replace the owner email and password
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

//go:embed public
var publicFS embed.FS

// The complete public surface of pages and assets (test/api.test.js reads this list).
var files = map[string]string{"/": "index.html", "/admin": "admin.html", "/app.js": "app.js", "/admin.js": "admin.js", "/ui.js": "ui.js", "/fees.js": "fees.js", "/styles.css": "styles.css", "/favicon.svg": "favicon.svg"}

var types = map[string]string{"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "svg": "image/svg+xml"}

var security = map[string]string{
	"Content-Security-Policy":           "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options":            "nosniff",
	"Referrer-Policy":                   "no-referrer",
	"X-Frame-Options":                   "DENY",
	"Strict-Transport-Security":         "max-age=31536000; includeSubDomains",
	"Cross-Origin-Resource-Policy":      "same-origin",
	"Cross-Origin-Opener-Policy":        "same-origin",
	"Permissions-Policy":                "camera=(), microphone=(), geolocation=()",
	"X-Permitted-Cross-Domain-Policies": "none",
}

const maxBody = 32 << 10

// Rate limits: new listings and hire requests count only when accepted; sign-ins count every attempt.
type limit struct {
	bucket       string
	max          int
	per          time.Duration
	acceptedOnly bool
}

var limits = map[string]limit{
	"POST /api/engineers":   {"s", 10, time.Hour, true},
	"POST /api/jobs":        {"s", 10, time.Hour, true},
	"POST /api/login":       {"l", 10, 15 * time.Minute, false},
	"POST /api/admin/login": {"l", 10, 15 * time.Minute, false},
}

type server struct {
	api        *API
	static     map[string][]byte
	trustProxy bool
	mu         sync.Mutex
	hits       map[string][]time.Time
	sessions   map[string]*Session
}

const cookieName = "__Host-sid" // __Host-: Secure, Path=/, no Domain, so no other site or subdomain can set it

func (sv *server) session(r *http.Request) *Session {
	c, err := r.Cookie(cookieName)
	if err != nil || len(c.Value) != 43 {
		return nil
	}
	sv.mu.Lock()
	defer sv.mu.Unlock()
	if s := sv.sessions[c.Value]; s != nil && time.Now().Before(s.Exp) {
		return s
	}
	return nil
}

func cookie(v string, age int) string {
	return fmt.Sprintf("%s=%s; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=%d", cookieName, v, age)
}

// apply swaps in a fresh session id on every sign-in and drops the old one.
func (sv *server) apply(r *http.Request, ch *Change) string {
	sv.mu.Lock()
	defer sv.mu.Unlock()
	if c, err := r.Cookie(cookieName); err == nil {
		delete(sv.sessions, c.Value)
	}
	if ch.Logout {
		return cookie("", 0)
	}
	b := make([]byte, 32)
	rand.Read(b)
	id := base64.RawURLEncoding.EncodeToString(b)
	s := *ch.Login
	s.Exp = time.Now().Add(8 * time.Hour)
	sv.sessions[id] = &s
	return cookie(id, 8*3600)
}

// clientIP: behind the host's proxy, the last X-Forwarded-For entry is the one the proxy added (earlier entries are
// whatever the client sent, so they can't be trusted).
func (sv *server) clientIP(r *http.Request) string {
	addr := r.RemoteAddr
	if sv.trustProxy {
		if xff := r.Header.Values("X-Forwarded-For"); len(xff) > 0 {
			parts := strings.Split(xff[len(xff)-1], ",")
			addr = strings.TrimSpace(parts[len(parts)-1])
		}
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func (sv *server) recent(key string, per time.Duration) []time.Time {
	now, kept := time.Now(), []time.Time{}
	for _, t := range sv.hits[key] {
		if now.Sub(t) < per {
			kept = append(kept, t)
		}
	}
	sv.hits[key] = kept
	return kept
}

func (sv *server) prune() {
	sv.mu.Lock()
	defer sv.mu.Unlock()
	now := time.Now()
	for k, v := range sv.hits {
		if len(v) == 0 || now.Sub(v[len(v)-1]) > time.Hour {
			delete(sv.hits, k)
		}
	}
	for k, s := range sv.sessions {
		if now.After(s.Exp) {
			delete(sv.sessions, k)
		}
	}
}

func send(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(body)
}

// sameOrigin: a browser POST from another site carries its Origin; refuse it (SameSite=Strict cookies and the JSON-only
// body already stop cross-site posts, this is a second lock).
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && u.Host == r.Host
}

func (sv *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	for k, v := range security {
		w.Header().Set(k, v)
	}
	w.Header().Set("Cache-Control", "no-store")
	defer func() {
		if p := recover(); p != nil {
			log.Printf("panic on %s %s: %v", r.Method, r.URL.Path, p)
			send(w, 500, map[string]string{"error": "server"})
		}
	}()
	// Behind the host's HTTPS proxy, send any plain-http visit to https.
	if sv.trustProxy && r.Header.Get("X-Forwarded-Proto") == "http" {
		http.Redirect(w, r, "https://"+r.Host+r.URL.RequestURI(), http.StatusMovedPermanently)
		return
	}
	path := r.URL.Path
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if body, found := sv.static[path]; found {
			w.Header().Set("Content-Type", types[files[path][strings.LastIndex(files[path], ".")+1:]])
			w.Header().Set("Cache-Control", "no-cache")
			w.Write(body)
			return
		}
	}
	route := r.Method + " " + path
	fn := sv.api.routes[route]
	if fn == nil {
		send(w, 404, map[string]string{"error": "not found"})
		return
	}
	b := B{}
	if r.Method == http.MethodPost {
		if !sameOrigin(r) {
			send(w, 403, map[string]string{"error": "origin"})
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			send(w, 415, map[string]string{"error": "request"})
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			send(w, 413, map[string]string{"error": "request"})
			return
		}
		if err != nil || json.Unmarshal(data, &b) != nil || b == nil {
			send(w, 400, map[string]string{"error": "request"})
			return
		}
	}
	lim, limited := limits[route]
	key := lim.bucket + sv.clientIP(r)
	if limited {
		sv.mu.Lock()
		seen := sv.recent(key, lim.per)
		if len(seen) >= lim.max {
			sv.mu.Unlock()
			send(w, 429, map[string]string{"error": "rate"})
			return
		}
		if !lim.acceptedOnly {
			sv.hits[key] = append(seen, time.Now())
		}
		sv.mu.Unlock()
		if web, _ := b["website"].(string); lim.acceptedOnly && web != "" { // honeypot: bots fill the hidden field
			sv.mu.Lock()
			sv.hits[key] = append(sv.hits[key], time.Now())
			sv.mu.Unlock()
			send(w, 201, map[string]bool{"ok": true})
			return
		}
	}
	res := fn(b, sv.session(r))
	if limited && lim.acceptedOnly && res.Status < 300 {
		sv.mu.Lock()
		sv.hits[key] = append(sv.hits[key], time.Now())
		sv.mu.Unlock()
	}
	if res.Change != nil {
		w.Header().Set("Set-Cookie", sv.apply(r, res.Change))
	}
	send(w, res.Status, res.Body)
}

func env(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func main() {
	dataDir := env("DATA_DIR", "./data")
	if len(os.Args) > 1 && os.Args[1] == "admin" {
		if err := setupOwner(dataDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	st, err := OpenStore(dataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	sv := &server{api: NewAPI(st, dataDir), static: map[string][]byte{}, trustProxy: os.Getenv("TRUST_PROXY") == "1", hits: map[string][]time.Time{}, sessions: map[string]*Session{}}
	for route, name := range files {
		if sv.static[route], err = publicFS.ReadFile("public/" + name); err != nil {
			log.Fatalf("missing page %s: %v", name, err)
		}
	}
	go func() {
		for range time.Tick(10 * time.Minute) {
			sv.prune()
		}
	}()
	ln, err := net.Listen("tcp", net.JoinHostPort(env("HOST", "127.0.0.1"), env("PORT", "8080")))
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: sv, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	fmt.Printf("listening http://%s\n", ln.Addr())
	go func() {
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// setupOwner asks for the owner email and password; typing is hidden on a real terminal.
func setupOwner(dir string) error {
	in := bufio.NewScanner(os.Stdin)
	fi, _ := os.Stdin.Stat()
	tty := fi.Mode()&os.ModeCharDevice != 0
	ask := func(q string, hide bool) string {
		fmt.Print(q)
		if hide && tty {
			stty("-echo")
			defer func() { stty("echo"); fmt.Println() }()
		}
		in.Scan()
		return strings.TrimRight(in.Text(), "\r")
	}
	email := strings.TrimSpace(ask("Owner email: ", false))
	pw := ask("Password (12+ characters): ", true)
	if pw != ask("Same password again: ", true) {
		return errors.New("The passwords don't match. Nothing was saved.")
	}
	if err := setOwner(dir, email, pw); err != nil {
		return err
	}
	fmt.Printf("Owner account saved for %s. Sign in at /admin.\n", email)
	return nil
}

func stty(arg string) {
	cmd := exec.Command("stty", arg)
	cmd.Stdin = os.Stdin
	cmd.Run()
}
