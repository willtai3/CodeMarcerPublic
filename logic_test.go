package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestFees(t *testing.T) {
	pst := time.FixedZone("PST", -8*3600)
	for _, c := range []struct {
		at   time.Time
		want int
	}{
		{time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC), 0},
		{time.Date(2027, 1, 31, 23, 59, 59, 0, pst), 0},
		{time.Date(2027, 2, 1, 0, 0, 0, 0, pst), feePct},
	} {
		if got := pctAt(c.at); got != c.want {
			t.Errorf("pctAt(%v) = %d, want %d", c.at, got, c.want)
		}
	}
	for _, c := range []struct {
		amount, pct int
		fee, payout float64
	}{{5000, 10, 500, 4500}, {1234, 10, 123.4, 1110.6}, {999, 0, 0, 999}} {
		if fee, payout := feeFor(c.amount, c.pct); fee != c.fee || payout != c.payout {
			t.Errorf("feeFor(%d, %d) = %v, %v; want %v, %v", c.amount, c.pct, fee, payout, c.fee, c.payout)
		}
	}
}

// The page shows fees from public/fees.js; it must say the same as the server.
func TestFeeRulesMatchThePage(t *testing.T) {
	js, err := os.ReadFile("public/fees.js")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`PROMO_END = Date\.UTC\((\d+), (\d+), (\d+), (\d+)\), FEE_PCT = (\d+)`).FindStringSubmatch(string(js))
	if m == nil {
		t.Fatal("fees.js: PROMO_END/FEE_PCT line not found")
	}
	want := []string{"2027", "1", "1", "8", "10"} // Date.UTC months are 0-based: 1 = February
	got := m[1:]
	if !reflect.DeepEqual(got, want) || promoEnd != time.Date(2027, 2, 1, 8, 0, 0, 0, time.UTC) || feePct != 10 {
		t.Errorf("fees.js says %v; server says %v and %d%%", got, promoEnd, feePct)
	}
}

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
	h := hashPassword("long enough password")
	if strings.Contains(h.Hash+h.Salt, "long enough") || h.Iter != 600_000 || h.Alg != "pbkdf2-sha256" {
		t.Fatalf("hash looks wrong: %+v", h)
	}
	if !verifyPassword(h, "long enough password") || verifyPassword(h, "long enough passworD") || verifyPassword(nil, "long enough password") {
		t.Error("verify gave the wrong answer")
	}
	weak := *h
	weak.Iter = 1
	if verifyPassword(&weak, "long enough password") {
		t.Error("a stored hash with too few rounds was accepted")
	}
}

func TestOwnerFile(t *testing.T) {
	dir := t.TempDir()
	if r := ownerLogin(dir, "a@b.co", "whatever password"); r != "setup" {
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
	if ownerLogin(dir, " me@example.com ", "long enough password") != "ok" || ownerLogin(dir, "me@example.com", "wrong password!!") != "" || ownerLogin(dir, "x@example.com", "long enough password") != "" {
		t.Error("owner login gave the wrong answer")
	}
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

// After Feb 1, 2027 the fee is fixed when the client sends the request and charged on completion.
func TestFeeLockedAtRequestTime(t *testing.T) {
	st, _ := OpenStore(t.TempDir())
	a := NewAPI(st, t.TempDir())
	clock := time.Date(2027, 1, 31, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return clock }
	res := a.routes["POST /api/engineers"](engineerBody(), nil)
	if res.Status != 201 {
		t.Fatalf("sign-up: %d %v", res.Status, res.Body)
	}
	me := res.Change.Login
	hire := func(who string) {
		r := a.routes["POST /api/jobs"](B{"engineerId": me.ID, "choice": "p0", "clientName": who, "clientEmail": who + "@example.com", "clientPhone": "555 123 4567", "details": "Please deploy my app."}, nil)
		if r.Status != 201 {
			t.Fatalf("hire: %d %v", r.Status, r.Body)
		}
	}
	hire("early")
	clock = time.Date(2027, 2, 2, 0, 0, 0, 0, time.UTC)
	hire("late")
	for _, j := range st.jobs {
		for _, to := range []string{"accepted", "complete"} {
			if r := a.routes["POST /api/me/jobs"](B{"id": j.ID, "status": to, "amount": "1000"}, me); r.Status != 200 {
				t.Fatalf("%s: %d %v", to, r.Status, r.Body)
			}
		}
	}
	for _, j := range st.jobs {
		want := map[string]float64{"early": 0, "late": 100}[j.ClientName]
		if *j.Fee != want || *j.Payout != 1000-want {
			t.Errorf("%s: fee %v payout %v, want fee %v", j.ClientName, *j.Fee, *j.Payout, want)
		}
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
