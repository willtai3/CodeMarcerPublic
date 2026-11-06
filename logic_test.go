package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTags(t *testing.T) {
	if got := tags("React.js, NodeJS ,node,  Next , "); !reflect.DeepEqual(got, []string{"react", "node", "next.js"}) {
		t.Errorf("tags = %v", got)
	}
	if got := tags([]any{"TS", "ts", 7}); !reflect.DeepEqual(got, []string{"typescript"}) {
		t.Errorf("tags(array) = %v", got)
	}
	many := make([]string, 20)
	for i := range many {
		many[i] = string(rune('a'+i)) + "x"
	}
	if got := tags(strings.Join(many, ",")); len(got) != 12 {
		t.Errorf("cap: %d tags", len(got))
	}
	if got := tags(strings.Repeat("x", 31) + ",bad\x00tag"); len(got) != 0 {
		t.Errorf("long and control-character tags kept: %v", got)
	}
}

func engineerBody() B {
	return B{"name": "Maya R.", "email": "maya@example.com", "phone": "(555) 123-4567", "headline": "I take AI-built apps live", "skills": "next, stripe", "rate": "120",
		"packages": []any{map[string]any{"title": "Deploy your app", "price": "400", "days": "5", "details": ""}}, "payWith": "Venmo @maya", "terms": "Upfront", "portfolio": "", "about": "", "available": true}
}

func with(b B, k string, v any) B {
	c := B{}
	for key, val := range b {
		c[key] = val
	}
	if v == nil {
		delete(c, k)
	} else {
		c[k] = v
	}
	return c
}

func TestProfileValidation(t *testing.T) {
	e, bad := profileOf(engineerBody(), true)
	if bad != "" || e.Email != "maya@example.com" || e.Phone != "(555) 123-4567" || *e.Rate != 120 || e.Packages[0].Price != 400 || e.Packages[0].Details != nil || e.About != nil {
		t.Fatalf("valid sign-up: bad=%q e=%+v", bad, e)
	}
	if _, bad := profileOf(with(with(engineerBody(), "rate", ""), "packages", []any{}), true); bad != "pricing" {
		t.Errorf("no rate and no packages: %q", bad)
	}
	for _, c := range []struct {
		k    string
		v    any
		want string
	}{
		{"email", "x", "email"}, {"phone", "12345", "phone"}, {"phone", nil, "phone"}, {"headline", "hi", "headline"}, {"skills", " , ", "skills"},
		{"rate", "5", "rate"}, {"rate", "12.5", "rate"}, {"rate", 12.5, "rate"}, {"rate", "-20", "rate"},
		{"packages", []any{map[string]any{"title": "ok title", "price": "10", "days": "2"}}, "packages"},
		{"payWith", "", "payWith"}, {"terms", "Never", "terms"}, {"portfolio", "http://x.example", "portfolio"},
		{"portfolio", "https://user:pw@x.example", "portfolio"}, {"portfolio", "javascript:alert(1)", "portfolio"},
		{"available", "yes", "available"}, {"name", "Maya‮", "name"}, {"name", "two\nlines", "name"},
	} {
		if _, bad := profileOf(with(engineerBody(), c.k, c.v), true); bad != c.want {
			t.Errorf("%s=%q: got %q, want %q", c.k, c.v, bad, c.want)
		}
	}
	if e, bad := profileOf(with(engineerBody(), "email", "other@example.com"), false); bad != "" || e.Email != "" {
		t.Errorf("an edit can't change the email: %q %q", bad, e.Email)
	}
	if _, ok := strOf(1, 1000, true)("line one\nline two"); !ok {
		t.Error("multi-line field refused a newline")
	}
}

func TestQuotes(t *testing.T) {
	rate := 120
	e := &Engineer{Rate: &rate, Packages: []Package{{Title: "Deploy", Price: 400, Days: 5}}}
	if c := quoteFor(e, "p0", nil); c == nil || c.Quote != 400 || c.Type != "package" {
		t.Errorf("p0: %+v", c)
	}
	if c := quoteFor(e, "hourly", "3"); c == nil || c.Quote != 360 {
		t.Errorf("hourly: %+v", c)
	}
	for _, c := range [][2]any{{"p1", nil}, {"p9", nil}, {"x", nil}, {nil, nil}, {"hourly", "0"}, {"hourly", "501"}, {"hourly", "2.5"}, {"__proto__", nil}} {
		if q := quoteFor(e, c[0], c[1]); q != nil {
			t.Errorf("quoteFor(%v, %v) = %+v, want refused", c[0], c[1], q)
		}
	}
	if q := quoteFor(&Engineer{}, "hourly", "3"); q != nil {
		t.Error("hourly without a rate accepted")
	}
}

func TestPhone(t *testing.T) {
	for _, ok := range []string{"(555) 123-4567", "+1 555 987 6543", "5551234567"} {
		if _, valid := phoneOf(ok); !valid {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "12345", "call me maybe", "+1 555 123 4567 8901 234", "555-12\n34567"} {
		if _, valid := phoneOf(bad); valid {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPasswords(t *testing.T) {
	h, err := hashPassword("long enough password")
	if err != nil || strings.Contains(h.Hash+h.Salt, "long enough") || h.Iter != 600_000 || h.Alg != "pbkdf2-sha256" {
		t.Fatalf("hash looks wrong: %+v %v", h, err)
	}
	check := func(h *Hash, pw string) bool { ok, err := verifyPassword(h, pw); return ok && err == nil }
	if !check(h, "long enough password") || check(h, "long enough passworD") || check(nil, "long enough password") {
		t.Error("verify gave the wrong answer")
	}
	weak := *h
	weak.Iter = 1
	if check(&weak, "long enough password") {
		t.Error("a stored hash with too few rounds was accepted")
	}
}

// Hardening: with every hashing slot taken, a request gives up after slotWait (answered 503) instead of queueing
// forever behind a flood.
func TestHashingGivesUpWhenEverySlotIsTaken(t *testing.T) {
	old := slotWait
	slotWait = 50 * time.Millisecond
	defer func() { slotWait = old }()
	for i := 0; i < cap(hashSlots); i++ {
		hashSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < cap(hashSlots); i++ {
			<-hashSlots
		}
	}()
	done := make(chan error, 1)
	go func() { _, err := hashPassword("long enough password"); done <- err }()
	select {
	case err := <-done:
		if err != errBusy {
			t.Fatalf("got %v, want errBusy", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("hashing waited for a slot with no time limit")
	}
	if _, err := verifyPassword(dummy, "x"); err != errBusy {
		t.Fatalf("verify: got %v, want errBusy", err)
	}
}

func TestOwnerFile(t *testing.T) {
	dir := t.TempDir()
	login := func(email, pw string) string {
		r, _, err := ownerLogin(dir, email, pw)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	if r := login("a@b.co", "whatever password"); r != "setup" {
		t.Errorf("no owner: %q", r)
	}
	if err := setOwner(dir, "a@b.co", "short"); err == nil {
		t.Error("short password accepted")
	}
	if err := setOwner(dir, "Me@Example.com", "long enough password"); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "admin.json")); fi.Mode().Perm() != 0o600 {
		t.Errorf("admin.json mode %v", fi.Mode().Perm())
	}
	if login(" me@example.com ", "long enough password") != "ok" || login("me@example.com", "wrong password!!") != "" || login("x@example.com", "long enough password") != "" {
		t.Error("owner login gave the wrong answer")
	}
}

// Hardening: replacing the owner password ends owner sessions made with the old one.
func TestOwnerSessionEndsWhenThePasswordIsReplaced(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	a := NewAPI(st, dir, &memMail{}, "https://codemarcer.test")
	if err := setOwner(dir, "me@example.com", "long enough password"); err != nil {
		t.Fatal(err)
	}
	res := a.routes["POST /api/admin/login"](B{"email": "me@example.com", "password": "long enough password"}, nil)
	if res.Status != 200 {
		t.Fatalf("login %d", res.Status)
	}
	s := *res.Change.Login
	if a.routes["GET /api/admin/data"](B{}, &s).Status != 200 {
		t.Fatal("fresh owner session refused")
	}
	if err := setOwner(dir, "me@example.com", "another long password"); err != nil {
		t.Fatal(err)
	}
	if got := a.routes["GET /api/admin/data"](B{}, &s).Status; got != 401 {
		t.Fatalf("old owner session after a new password: %d, want 401", got)
	}
	if got := a.routes["GET /api/admin/data"](B{}, &Session{Role: "owner"}).Status; got != 401 {
		t.Fatalf("owner session with no version: %d, want 401", got)
	}
}

// Hardening: IPv6 visitors share a limit per /64, so rotating addresses inside one block doesn't reset it.
func TestIPKeyGroupsIPv6By64(t *testing.T) {
	if ipKey("2001:db8:1:2::1") != ipKey("2001:db8:1:2:ffff:ffff:ffff:fffe") {
		t.Error("two addresses in one /64 got different keys")
	}
	if ipKey("2001:db8:1:2::1") == ipKey("2001:db8:1:3::1") {
		t.Error("two /64s share a key")
	}
	if ipKey("203.0.113.9") != "203.0.113.9" || ipKey("::ffff:203.0.113.9") != "203.0.113.9" {
		t.Error("IPv4 keys changed")
	}
}

// Hardening: on Azure App Service the server won't start without TRUST_PROXY=1.
func TestRefusesAzureWithoutTrustProxy(t *testing.T) {
	if proxyProblem("codemarcer-1", "") == "" || proxyProblem("codemarcer-1", "0") == "" {
		t.Error("started on App Service without TRUST_PROXY=1")
	}
	if proxyProblem("codemarcer-1", "1") != "" || proxyProblem("", "") != "" {
		t.Error("refused a correct setup")
	}
}

// Hardening: invisible characters can't be used to make one name look like another.
func TestInvisibleCharacters(t *testing.T) {
	line, text := strOf(1, 80, false), strOf(1, 1000, true)
	for _, bad := range []string{"Ann\u200bLee", "Ann\u200eLee", "\ufeffAnn", "Ann\u2028Lee", "Ann\u0085Lee", "Ann\u2066Lee"} {
		if _, ok := line(bad); ok {
			t.Errorf("single-line field accepted %q", bad)
		}
	}
	for _, bad := range []string{"line one\u2028line two", "x\u202ey"} {
		if _, ok := text(bad); ok {
			t.Errorf("multi-line field accepted %q", bad)
		}
	}
	if _, ok := text("I build apps 👩\u200d💻\nand fix them"); !ok {
		t.Error("multi-line field refused an emoji with a zero-width joiner")
	}
	if _, ok := line("José Núñez"); !ok {
		t.Error("refused an accented name")
	}
}

// Hardening: replies are encoded after the store lock is released, so they must be copies. Run with -race.
func TestConcurrentRequestsDontRace(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenStore(dir)
	mm := &memMail{}
	sv := &server{api: NewAPI(st, dir, mm, "https://codemarcer.test"), static: map[string][]byte{}, hits: map[string][]time.Time{}, sessions: map[string]*Session{}}
	n := 0
	do := func(m, p, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(m, p, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		sv.mu.Lock()
		n++
		r.RemoteAddr = fmt.Sprintf("10.0.%d.%d:1", n/250, n%250) // a new address each time, so no limit is hit
		sv.mu.Unlock()
		w := httptest.NewRecorder()
		sv.ServeHTTP(w, r)
		return w
	}
	listing := `"name":"A","phone":"5551234567","headline":"hello there","skills":"go","rate":50,"payWith":"cash","terms":"Upfront","available":true`
	if w := do("POST", "/api/engineers", `{"email":"a@b.co",`+listing+`}`); w.Code != 201 {
		t.Fatalf("listing %d", w.Code)
	}
	key := mm.key(t, 0)
	var id string
	for k := range st.engineers {
		id = k
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(5)
		go func() { defer wg.Done(); do("GET", "/api/engineers", "") }()
		go func() { defer wg.Done(); do("GET", "/api/engineers", "") }()
		go func() { defer wg.Done(); do("POST", "/api/listing", `{"key":"`+key+`"}`) }()
		go func(i int) {
			defer wg.Done()
			do("POST", "/api/listing/save", `{"key":"`+key+`",`+strings.Replace(listing, `"rate":50`, fmt.Sprintf(`"rate":%d`, 50+i), 1)+`}`)
		}(i)
		go func() {
			defer wg.Done()
			do("POST", "/api/jobs", `{"engineerId":"`+id+`","choice":"hourly","hours":2,"clientName":"C","clientEmail":"c@d.co","clientPhone":"5551234567","details":"0123456789ab"}`)
		}()
	}
	wg.Wait()
}

// memMail keeps sent emails for tests.
type memMail struct {
	mu   sync.Mutex
	sent []mail
}

func (m *memMail) Send(to, subject, text string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, mail{to, subject, text})
	return nil
}

var editRe = regexp.MustCompile(`#edit=([0-9a-f-]+\.[A-Za-z0-9_-]{43})`)

// key returns the edit key from the i-th email sent.
func (m *memMail) key(t *testing.T, i int) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if i >= len(m.sent) {
		t.Fatalf("only %d emails sent", len(m.sent))
	}
	k := editRe.FindStringSubmatch(m.sent[i].text)
	if k == nil {
		t.Fatalf("no edit link in %q", m.sent[i].text)
	}
	return k[1]
}

// No sign-in for engineers: a listing is managed with a private link sent to its email.
func TestEditLinks(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	mm := &memMail{}
	a := NewAPI(st, t.TempDir(), mm, "https://codemarcer.test/")
	clock := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return clock }
	call := func(route string, b B) Result { return a.routes[route](b, nil) }
	if r := call("POST /api/engineers", engineerBody()); r.Status != 201 || r.Change != nil {
		t.Fatalf("listing: %d %v", r.Status, r.Change)
	}
	if len(mm.sent) != 1 || mm.sent[0].to != "maya@example.com" || !strings.Contains(mm.sent[0].text, "https://codemarcer.test/#edit=") {
		t.Fatalf("email: %+v", mm.sent)
	}
	key := mm.key(t, 0)
	var e *Engineer
	for _, x := range st.engineers {
		e = x
	}
	if e.EditKey == "" || strings.Contains(e.EditKey, strings.Split(key, ".")[1]) {
		t.Error("the link's secret is stored instead of its hash")
	}
	if r := call("POST /api/listing", B{"key": key}); r.Status != 200 || r.Body.(Engineer).EditKey != "" || r.Body.(Engineer).Phone != "(555) 123-4567" {
		t.Errorf("open with the link: %d %+v", r.Status, r.Body)
	}
	for _, bad := range []any{nil, "", e.ID, e.ID + ".", e.ID + "." + strings.Repeat("A", 43), "x." + strings.Split(key, ".")[1], key + "x"} {
		if r := call("POST /api/listing", B{"key": bad}); r.Status != 401 {
			t.Errorf("key %q: %d", bad, r.Status)
		}
	}
	if r := call("POST /api/listing/save", with(B{"key": "nope"}, "name", "")); r.Status != 401 {
		t.Errorf("save with a wrong link and a bad body: %d, want 401 before validation", r.Status)
	}
	if r := call("POST /api/listing/save", with(with(engineerBody(), "key", key), "email", "thief@example.com")); r.Status != 200 || e.Email != "maya@example.com" {
		t.Errorf("save: %d, email now %q", r.Status, e.Email)
	}
	// Listing the same email again doesn't make a second listing or say it exists; it sends a new link.
	clock = clock.Add(11 * time.Minute)
	if r := call("POST /api/engineers", with(engineerBody(), "name", "Someone Else")); r.Status != 201 || len(st.engineers) != 1 || e.Name != "Maya R." || len(mm.sent) != 2 {
		t.Fatalf("listing a taken email: %d, %d listings, name %q, %d emails", r.Status, len(st.engineers), e.Name, len(mm.sent))
	}
	if call("POST /api/listing", B{"key": key}).Status != 401 || call("POST /api/listing", B{"key": mm.key(t, 1)}).Status != 200 {
		t.Error("a new link didn't replace the old one")
	}
	// "Email me my link": the same answer for unknown emails, and at most one email per address per 10 minutes.
	for _, email := range []string{"maya@example.com", "nobody@example.com", "MAYA@example.com"} {
		if r := call("POST /api/edit-link", B{"email": email}); r.Status != 200 {
			t.Errorf("%s: %d", email, r.Status)
		}
	}
	if len(mm.sent) != 2 {
		t.Errorf("%d emails: sent within 10 minutes of the last one, or to an unlisted address", len(mm.sent))
	}
	clock = clock.Add(11 * time.Minute)
	call("POST /api/edit-link", B{"email": " Maya@Example.com "})
	if len(mm.sent) != 3 {
		t.Fatalf("%d emails after the gap", len(mm.sent))
	}
	if r := call("POST /api/listing/remove", B{"key": mm.key(t, 2)}); r.Status != 200 || len(st.engineers) != 0 || len(st.byEmail) != 0 {
		t.Errorf("remove: %d, %d left", r.Status, len(st.engineers))
	}
}

// The hire reply hands the client the engineer's contact and payment details.
func TestHireShowsContact(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	a := NewAPI(st, t.TempDir(), &memMail{}, "https://codemarcer.test")
	a.routes["POST /api/engineers"](engineerBody(), nil)
	var id string
	for k := range st.engineers {
		id = k
	}
	r := a.routes["POST /api/jobs"](B{"engineerId": id, "choice": "p0", "clientName": "Ann", "clientEmail": "ann@example.com", "clientPhone": "5551234567", "details": "Login breaks after deploy."}, nil)
	want := map[string]string{"name": "Maya R.", "email": "maya@example.com", "phone": "(555) 123-4567", "payWith": "Venmo @maya", "terms": "Upfront"}
	if r.Status != 201 || !reflect.DeepEqual(r.Body.(map[string]any)["engineer"], want) {
		t.Errorf("%d %+v", r.Status, r.Body)
	}
}

// The email request to Azure Communication Services is signed the way the service checks it.
func TestACSMailer(t *testing.T) {
	var got *http.Request
	var body []byte
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, body = r, must(io.ReadAll(r.Body))
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	m, err := newACS("endpoint="+srv.URL+"/;accesskey="+key, "DoNotReply@example.azurecomm.net")
	if err != nil {
		t.Fatal(err)
	}
	m.client = srv.Client()
	m.now = func() time.Time { return time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC) }
	if err := m.Send("maya@example.com", "Subject", "Body text"); err != nil {
		t.Fatal(err)
	}
	if got.URL.RequestURI() != "/emails:send?api-version=2023-03-31" || got.Header.Get("x-ms-date") != "Fri, 06 Nov 2026 12:00:00 GMT" {
		t.Errorf("request %s, date %q", got.URL.RequestURI(), got.Header.Get("x-ms-date"))
	}
	sum := sha256.Sum256(body)
	hash := base64.StdEncoding.EncodeToString(sum[:])
	mac := hmac.New(sha256.New, []byte("0123456789abcdef0123456789abcdef"))
	mac.Write([]byte("POST\n/emails:send?api-version=2023-03-31\nFri, 06 Nov 2026 12:00:00 GMT;" + got.Host + ";" + hash))
	if got.Header.Get("x-ms-content-sha256") != hash || got.Header.Get("Authorization") != "HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature="+base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
		t.Errorf("signature headers: %v", got.Header)
	}
	var sent struct {
		SenderAddress string
		Recipients    struct{ To []struct{ Address string } }
		Content       struct{ Subject, PlainText string }
	}
	json.Unmarshal(body, &sent)
	if sent.SenderAddress != "DoNotReply@example.azurecomm.net" || sent.Recipients.To[0].Address != "maya@example.com" || sent.Content.PlainText != "Body text" {
		t.Errorf("body %s", body)
	}
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) })
	if m.Send("a@b.co", "s", "t") == nil {
		t.Error("a refused email counted as sent")
	}
	for _, bad := range []string{"", "endpoint=http://x.example/;accesskey=" + key, "endpoint=https://x.example/;accesskey=not base64!"} {
		if _, err := newACS(bad, "a@b.co"); err == nil {
			t.Errorf("accepted connection string %q", bad)
		}
	}
}

// A live site must really send edit links.
func TestRefusesAzureWithoutEmail(t *testing.T) {
	if _, err := mailerFrom("codemarcer-1", "", ""); err == nil {
		t.Error("started on App Service with emails only printed to the log")
	}
	if m, err := mailerFrom("", "", ""); err != nil || m == nil {
		t.Error("refused the log mailer for local use")
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func TestStoreRollsBackWhenTheWriteFails(t *testing.T) {
	st, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &Engineer{ID: "e1", Kind: "engineer", Email: "a@b.co", Name: "A"}
	if err := st.addEngineer(e); err != nil {
		t.Fatal(err)
	}
	st.write = func(string, []byte) error { return errors.New("disk full") }
	if err := change(st, e, func(e *Engineer) { e.Name = "B" }); err == nil || e.Name != "A" {
		t.Errorf("failed write: err=%v name=%q (want A)", err, e.Name)
	}
	if err := st.addEngineer(&Engineer{ID: "e2", Email: "c@d.co"}); err == nil || st.engineers["e2"] != nil || st.byEmail["c@d.co"] != nil {
		t.Error("a failed add left the record in memory")
	}
	st.write = atomicWrite
	if err := change(st, e, func(e *Engineer) { e.Name = "C" }); err != nil {
		t.Fatal(err)
	}
	again, _ := OpenStore(filepath.Dir(st.file))
	if again.engineers["e1"].Name != "C" || again.byEmail["a@b.co"] == nil {
		t.Error("reopened store lost the change")
	}
	if fi, _ := os.Stat(st.file); fi.Mode().Perm() != 0o600 {
		t.Errorf("store.json mode %v", fi.Mode().Perm())
	}
}

// A failed write answers 500 and leaves nothing half-done.
func TestFailedWriteAnswers500(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	a := NewAPI(st, t.TempDir(), &memMail{}, "https://codemarcer.test")
	st.write = func(string, []byte) error { return errors.New("disk full") }
	if r := a.routes["POST /api/engineers"](engineerBody(), nil); r.Status != 500 || len(st.engineers) != 0 || len(st.byEmail) != 0 {
		t.Errorf("listing on a full disk: status %d, %d engineers", r.Status, len(st.engineers))
	}
}
