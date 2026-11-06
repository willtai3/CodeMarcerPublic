package main

import (
	"errors"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
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
	return B{"name": "Maya R.", "email": "maya@example.com", "password": "maya password 1", "headline": "I take AI-built apps live", "skills": "next, stripe", "rate": "120",
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
	e, pw, bad := profileOf(engineerBody(), true)
	if bad != "" || pw != "maya password 1" || *e.Rate != 120 || e.Packages[0].Price != 400 || e.Packages[0].Details != nil || e.About != nil {
		t.Fatalf("valid sign-up: bad=%q e=%+v", bad, e)
	}
	if _, _, bad := profileOf(with(with(engineerBody(), "rate", ""), "packages", []any{}), true); bad != "pricing" {
		t.Errorf("no rate and no packages: %q", bad)
	}
	for _, c := range []struct {
		k    string
		v    any
		want string
	}{
		{"email", "x", "email"}, {"password", "short", "password"}, {"headline", "hi", "headline"}, {"skills", " , ", "skills"},
		{"rate", "5", "rate"}, {"rate", "12.5", "rate"}, {"rate", 12.5, "rate"}, {"rate", "-20", "rate"},
		{"packages", []any{map[string]any{"title": "ok title", "price": "10", "days": "2"}}, "packages"},
		{"payWith", "", "payWith"}, {"terms", "Never", "terms"}, {"portfolio", "http://x.example", "portfolio"},
		{"portfolio", "https://user:pw@x.example", "portfolio"}, {"portfolio", "javascript:alert(1)", "portfolio"},
		{"available", "yes", "available"}, {"name", "Maya‮", "name"}, {"name", "two\nlines", "name"},
	} {
		if _, _, bad := profileOf(with(engineerBody(), c.k, c.v), true); bad != c.want {
			t.Errorf("%s=%q: got %q, want %q", c.k, c.v, bad, c.want)
		}
	}
	if _, _, bad := profileOf(with(with(engineerBody(), "email", nil), "password", nil), false); bad != "" {
		t.Errorf("edit without email/password: %q", bad)
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

func TestJobStatusOnlyMovesForward(t *testing.T) {
	for _, c := range []struct {
		from, to string
		want     bool
	}{{"requested", "accepted", true}, {"requested", "complete", false}, {"accepted", "paid", true}, {"paid", "complete", true}, {"complete", "accepted", false}, {"declined", "accepted", false}} {
		if got := allowed(next, c.from, c.to); got != c.want {
			t.Errorf("%s → %s: %v", c.from, c.to, got)
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
	a := NewAPI(st, dir)
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
	sv := &server{api: NewAPI(st, dir), static: map[string][]byte{}, hits: map[string][]time.Time{}, sessions: map[string]*Session{}}
	n := 0
	do := func(m, p, body, c string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(m, p, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		sv.mu.Lock()
		n++
		r.RemoteAddr = fmt.Sprintf("10.0.%d.%d:1", n/250, n%250) // a new address each time, so no limit is hit
		sv.mu.Unlock()
		if c != "" {
			r.Header.Set("Cookie", c)
		}
		w := httptest.NewRecorder()
		sv.ServeHTTP(w, r)
		return w
	}
	w := do("POST", "/api/engineers", `{"name":"A","email":"a@b.co","password":"pppppppppppp","headline":"hello there","skills":"go","rate":50,"payWith":"cash","terms":"Upfront","available":true}`, "")
	c := strings.Split(w.Header().Get("Set-Cookie"), ";")[0]
	var id string
	for k := range st.engineers {
		id = k
	}
	for i := 0; i < 20; i++ {
		do("POST", "/api/jobs", `{"engineerId":"`+id+`","choice":"hourly","hours":2,"clientName":"C","clientEmail":"c@d.co","clientPhone":"5551234567","details":"0123456789ab"}`, "")
	}
	jobs := []string{}
	for k := range st.jobs {
		jobs = append(jobs, k)
	}
	if len(jobs) != 20 {
		t.Fatalf("%d jobs", len(jobs))
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(5)
		go func() { defer wg.Done(); do("GET", "/api/me", "", c) }()
		go func() { defer wg.Done(); do("GET", "/api/engineers", "", "") }()
		go func() { defer wg.Done(); do("GET", "/api/engineers", "", "") }()
		go func(i int) {
			defer wg.Done()
			do("POST", "/api/me/jobs", `{"id":"`+jobs[i]+`","status":"accepted"}`, c)
		}(i)
		go func(i int) { // the same job from another request, so a reply can be written while the job changes
			defer wg.Done()
			for k := 0; k < 20; k++ {
				do("POST", "/api/me/jobs", `{"id":"`+jobs[i]+`","status":"paid"}`, c)
			}
		}(i)
	}
	wg.Wait()
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
	a := NewAPI(st, t.TempDir())
	st.write = func(string, []byte) error { return errors.New("disk full") }
	if r := a.routes["POST /api/engineers"](engineerBody(), nil); r.Status != 500 || r.Change != nil || len(st.engineers) != 0 {
		t.Errorf("sign-up on a full disk: status %d, session %v, %d engineers", r.Status, r.Change, len(st.engineers))
	}
}
