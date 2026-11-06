package main

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Every API route: (body, session) → (status, JSON value, session change).
// Roles: "engineer" (site account), "owner" (made with `codemarcer admin`), and staff members as "admin" or
// "moderator". A session's role is re-read from the store on every request, so a removed or demoted member loses
// access at once. Clients have no account: a hire request carries their name, email and phone.

type Session struct {
	Role string    // "engineer", "owner" or "staff"
	ID   string    // engineer or staff id
	Exp  time.Time // set by the server
}

type Change struct {
	Login  *Session
	Logout bool
}

type Result struct {
	Status int
	Body   any
	Change *Change
}

type handler func(b B, s *Session) Result

type API struct {
	st      *Store
	now     func() time.Time
	dataDir string
	routes  map[string]handler
	public  struct {
		version int
		list    []publicProfile
	}
}

func ok(body any) Result { return Result{Status: 200, Body: body} }
func fail(code int, e string) Result {
	return Result{Status: code, Body: map[string]string{"error": e}}
}

var (
	denied = fail(401, "auth")
	gone   = fail(404, "not found")
)

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (a *API) stamp() string { return a.now().UTC().Format("2006-01-02T15:04:05.000Z") }

func (a *API) pricing() map[string]any {
	return map[string]any{"pct": pctAt(a.now()), "feePct": feePct, "promoEnd": promoEnd.UnixMilli()}
}

// role resolves a session to its current role, or "" when it no longer grants anything. Call with st.mu held.
func (a *API) role(s *Session) string {
	switch {
	case s == nil:
		return ""
	case s.Role == "owner":
		return "owner"
	case s.Role == "staff":
		if x := a.st.staff[s.ID]; x != nil && !x.Removed {
			return x.Role
		}
	case s.Role == "engineer":
		if a.st.engineers[s.ID] != nil {
			return "engineer"
		}
	}
	return ""
}

// Views: what each audience may see. `auth` is never included.

type publicProfile struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Headline  string    `json:"headline"`
	Skills    []string  `json:"skills"`
	Rate      *int      `json:"rate"`
	Packages  []Package `json:"packages"`
	Terms     string    `json:"terms"`
	Portfolio *string   `json:"portfolio"`
	About     *string   `json:"about"`
	Available bool      `json:"available"`
	Created   string    `json:"created"`
}

func private(e *Engineer) Engineer { c := *e; c.Auth = nil; return c }
func privateStaff(x *Staff) Staff  { c := *x; c.Auth = nil; return c }

func newestFirst[T any](list []T, created func(T) string) []T {
	sort.SliceStable(list, func(i, j int) bool { return created(list[i]) > created(list[j]) })
	return list
}

// directory is the public list: hidden engineers left out, available ones first, newest first.
// It is rebuilt only when the store changes. Call with st.mu held for reading.
func (a *API) directory() []publicProfile {
	if a.public.list != nil && a.public.version == a.st.version {
		return a.public.list
	}
	list := []publicProfile{}
	for _, e := range a.st.engineers {
		if !e.Hidden {
			list = append(list, publicProfile{e.ID, e.Name, e.Headline, e.Skills, e.Rate, e.Packages, e.Terms, e.Portfolio, e.About, e.Available, e.Created})
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Available != list[j].Available {
			return list[i].Available
		}
		return list[i].Created > list[j].Created
	})
	a.public.version, a.public.list = a.st.version, list
	return list
}

var phoneRe = regexp.MustCompile(`^\+?[0-9 ().-]+$`)

func phoneOf(v any) (any, bool) {
	s, ok := strOf(7, 25, false)(v)
	if !ok || !phoneRe.MatchString(s.(string)) {
		return nil, false
	}
	n := 0
	for _, r := range s.(string) {
		if r >= '0' && r <= '9' {
			n++
		}
	}
	return s, n >= 7 && n <= 15
}

var hireSpec = []check{{"clientName", strOf(1, 80, false)}, {"clientEmail", emailOf}, {"clientPhone", phoneOf}, {"details", strOf(10, 2000, true)}, {"link", opt(linkOf)}}

func NewAPI(st *Store, dataDir string) *API {
	a := &API{st: st, now: time.Now, dataDir: dataDir}
	a.routes = map[string]handler{
		"GET /api/engineers": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			return ok(a.directory())
		},
		"GET /api/pricing": func(b B, s *Session) Result { return ok(a.pricing()) },

		// Sign-up: the password is hashed before the lock; the email check and the add then happen under one lock,
		// so two sign-ups with the same email can't both succeed.
		"POST /api/engineers": func(b B, s *Session) Result {
			e, pw, bad := profileOf(b, true)
			if bad != "" {
				return fail(400, bad)
			}
			e.Auth = hashPassword(pw)
			st.mu.Lock()
			defer st.mu.Unlock()
			if st.byEmail[e.Email] != nil {
				return fail(409, "email-taken")
			}
			e.ID, e.Kind, e.Created = newID(), "engineer", a.stamp()
			if err := st.addEngineer(e); err != nil {
				return fail(500, "server")
			}
			return Result{201, map[string]string{"role": "engineer"}, &Change{Login: &Session{Role: "engineer", ID: e.ID}}}
		},
		"POST /api/login": func(b B, s *Session) Result {
			email, _ := b["email"].(string)
			pw, _ := b["password"].(string)
			st.mu.RLock()
			e := st.byEmail[strings.ToLower(strings.TrimSpace(email))]
			var h *Hash
			if e != nil {
				h = e.Auth
			}
			st.mu.RUnlock()
			if !verifyPassword(h, pw) || e == nil {
				return denied
			}
			return Result{200, map[string]string{"role": "engineer"}, &Change{Login: &Session{Role: "engineer", ID: e.ID}}}
		},
		"POST /api/logout": func(b B, s *Session) Result { return Result{200, map[string]bool{"ok": true}, &Change{Logout: true}} },

		// A hire request needs no account: name, email, phone and a description of the project.
		"POST /api/jobs": func(b B, s *Session) Result {
			id, _ := b["engineerId"].(string)
			st.mu.Lock()
			defer st.mu.Unlock()
			e := st.engineers[id]
			if e == nil || e.Hidden || !e.Available {
				return fail(404, "engineer")
			}
			c := quoteFor(e, b["choice"], b["hours"])
			if c == nil {
				if b["choice"] == "hourly" {
					return fail(400, "hours")
				}
				return fail(400, "choice")
			}
			d, bad := validate(hireSpec, b)
			if bad != "" {
				return fail(400, bad)
			}
			j := &Job{ID: newID(), Kind: "job", Created: a.stamp(), EngineerID: e.ID, ClientName: d["clientName"].(string), ClientEmail: d["clientEmail"].(string), ClientPhone: d["clientPhone"].(string), Details: d["details"].(string), Link: strPtr(d["link"]), Choice: *c, Quote: c.Quote, Pct: pctAt(a.now()), Status: "requested"}
			if err := st.addJob(j); err != nil {
				return fail(500, "server")
			}
			return Result{201, map[string]any{"engineer": map[string]string{"name": e.Name, "email": e.Email, "payWith": e.PayWith, "terms": e.Terms}, "quote": c.Quote}, nil}
		},

		"GET /api/me": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			if a.role(s) != "engineer" {
				return denied
			}
			jobs := []*Job{}
			for _, j := range st.jobs {
				if j.EngineerID == s.ID {
					jobs = append(jobs, j)
				}
			}
			return ok(map[string]any{"role": "engineer", "profile": private(st.engineers[s.ID]), "jobs": newestFirst(jobs, func(j *Job) string { return j.Created }), "pricing": a.pricing()})
		},
		"POST /api/me": func(b B, s *Session) Result {
			st.mu.RLock()
			r := a.role(s)
			st.mu.RUnlock()
			if r != "engineer" { // signed-out requests learn nothing about validation
				return denied
			}
			upd, _, bad := profileOf(b, false)
			if bad != "" {
				return fail(400, bad)
			}
			var auth *Hash
			if pw, _ := b["password"].(string); pw != "" {
				if _, ok := passwordOf(pw); !ok {
					return fail(400, "password")
				}
				auth = hashPassword(pw)
			}
			st.mu.Lock()
			defer st.mu.Unlock()
			if a.role(s) != "engineer" {
				return denied
			}
			// Only profile fields change; email, hidden and the id can't be set from here.
			if err := change(st, st.engineers[s.ID], func(e *Engineer) {
				e.Name, e.Headline, e.Skills, e.Rate, e.Packages, e.PayWith, e.Terms, e.Portfolio, e.About, e.Available = upd.Name, upd.Headline, upd.Skills, upd.Rate, upd.Packages, upd.PayWith, upd.Terms, upd.Portfolio, upd.About, upd.Available
				if auth != nil {
					e.Auth = auth
				}
			}); err != nil {
				return fail(500, "server")
			}
			return ok(map[string]bool{"ok": true})
		},
		// The engineer moves a job through its statuses. The fee rate was fixed when the client sent the request;
		// completing applies it to the final amount.
		"POST /api/me/jobs": func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			to, _ := b["status"].(string)
			st.mu.Lock()
			defer st.mu.Unlock()
			if a.role(s) != "engineer" {
				return denied
			}
			j := st.jobs[id]
			if j == nil || j.EngineerID != s.ID {
				return gone
			}
			if !allowed(next, j.Status, to) {
				return fail(409, "status")
			}
			amount := any(j.Quote)
			if v, set := b["amount"]; set && v != nil {
				amount = v
			}
			n, valid := intOf(1, 10_000_000)(amount)
			if to == "complete" && !valid {
				return fail(400, "amount")
			}
			if err := change(st, j, func(j *Job) {
				j.Status = to
				if to == "complete" {
					amt, stamp := n.(int), a.stamp()
					fee, payout := feeFor(amt, j.Pct)
					j.Amount, j.Fee, j.Payout, j.Completed = &amt, &fee, &payout, &stamp
				}
			}); err != nil {
				return fail(500, "server")
			}
			return ok(j)
		},

		"POST /api/admin/login": func(b B, s *Session) Result {
			email, _ := b["email"].(string)
			pw, _ := b["password"].(string)
			if o := ownerLogin(a.dataDir, email, pw); o == "ok" {
				return Result{200, map[string]string{"role": "owner"}, &Change{Login: &Session{Role: "owner"}}}
			} else {
				st.mu.RLock()
				var m *Staff
				for _, x := range st.staff {
					if x.Email == strings.ToLower(strings.TrimSpace(email)) && !x.Removed {
						m = x
					}
				}
				var h *Hash
				if m != nil {
					h = m.Auth
				}
				st.mu.RUnlock()
				if verifyPassword(h, pw) && m != nil {
					return Result{200, map[string]string{"role": m.Role}, &Change{Login: &Session{Role: "staff", ID: m.ID}}}
				}
				if o == "setup" {
					return fail(503, "setup")
				}
			}
			return denied
		},
		"POST /api/admin/logout": func(b B, s *Session) Result { return Result{200, map[string]bool{"ok": true}, &Change{Logout: true}} },

		// Each part of the data is included only if the signed-in role has the permission for it.
		"GET /api/admin/data": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			r := a.role(s)
			if perms[r] == nil {
				if r != "" {
					return fail(403, "role")
				}
				return denied
			}
			count := map[string]int{}
			jobs := make([]*Job, 0, len(st.jobs))
			for _, j := range st.jobs {
				jobs, count[j.EngineerID] = append(jobs, j), count[j.EngineerID]+1
			}
			newestFirst(jobs, func(j *Job) string { return j.Created })
			type engRow struct {
				Engineer
				Jobs int `json:"jobs"`
			}
			engineers := make([]engRow, 0, len(st.engineers))
			for _, e := range st.engineers {
				engineers = append(engineers, engRow{private(e), count[e.ID]})
			}
			out := map[string]any{"me": map[string]any{"role": r, "perms": perms[r]}, "engineers": newestFirst(engineers, func(e engRow) string { return e.Created }), "pricing": a.pricing()}
			if can(r, "accounts") {
				// Clients have no accounts; this lists everyone who has sent a request, grouped by email, latest details first.
				type clientRow struct {
					Name    string `json:"name"`
					Email   string `json:"email"`
					Phone   string `json:"phone"`
					Jobs    int    `json:"jobs"`
					Created string `json:"created"`
					Last    string `json:"last"`
				}
				by := map[string]*clientRow{}
				clients := []*clientRow{}
				for i := len(jobs) - 1; i >= 0; i-- { // oldest first, so later requests overwrite name and phone
					j := jobs[i]
					c := by[j.ClientEmail]
					if c == nil {
						c = &clientRow{Email: j.ClientEmail, Created: j.Created}
						by[j.ClientEmail], clients = c, append(clients, c)
					}
					c.Name, c.Phone, c.Last, c.Jobs = j.ClientName, j.ClientPhone, j.Created, c.Jobs+1
				}
				out["clients"] = newestFirst(clients, func(c *clientRow) string { return c.Last })
			}
			if can(r, "money") {
				type jobRow struct {
					*Job
					Engineer string `json:"engineer"`
				}
				rows := make([]jobRow, 0, len(jobs))
				done, billed, fees := 0, 0, 0.0
				for _, j := range jobs {
					name := "(removed)"
					if e := st.engineers[j.EngineerID]; e != nil {
						name = e.Name
					}
					rows = append(rows, jobRow{j, name})
					if j.Status == "complete" {
						done, billed, fees = done+1, billed+*j.Amount, fees+*j.Fee
					}
				}
				out["jobs"], out["totals"] = rows, map[string]any{"requested": len(jobs), "completed": done, "billed": billed, "fees": float64(int(fees*100+0.5)) / 100}
			}
			if can(r, "staff") {
				staff := []Staff{}
				for _, x := range st.staff {
					if !x.Removed {
						staff = append(staff, privateStaff(x))
					}
				}
				out["staff"] = newestFirst(staff, func(x Staff) string { return x.Created })
			}
			return ok(out)
		},
		"POST /api/admin/hide": a.staffOnly("moderate", func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			hidden, isBool := b["hidden"].(bool)
			e := st.engineers[id]
			if e == nil {
				return gone
			}
			if !isBool {
				return fail(400, "hidden")
			}
			if err := change(st, e, func(e *Engineer) { e.Hidden = hidden }); err != nil {
				return fail(500, "server")
			}
			return ok(private(e))
		}),
		// No email yet, so a forgotten engineer password is fixed by staff setting a temporary one.
		"POST /api/admin/password": a.staffOnly("accounts", func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			e := st.engineers[id]
			if e == nil {
				return gone
			}
			pw, valid := passwordOf(b["password"])
			if !valid {
				return fail(400, "password")
			}
			st.mu.Unlock() // hash outside the lock, then re-take it and re-check the role and the engineer
			h := hashPassword(pw.(string))
			st.mu.Lock()
			if !can(a.role(s), "accounts") {
				return denied
			}
			if e = st.engineers[id]; e == nil {
				return gone
			}
			if err := change(st, e, func(e *Engineer) { e.Auth = h }); err != nil {
				return fail(500, "server")
			}
			return ok(map[string]bool{"ok": true})
		}),
		"POST /api/admin/staff": a.staffOnly("staff", func(b B, s *Session) Result {
			d, bad := validate(staffSpec, b)
			if bad != "" {
				return fail(400, bad)
			}
			st.mu.Unlock() // hash outside the lock, then re-take it and re-check the role
			h := hashPassword(d["password"].(string))
			st.mu.Lock()
			if !can(a.role(s), "staff") {
				return denied
			}
			for _, x := range st.staff {
				if x.Email == d["email"] && !x.Removed {
					return fail(409, "email-taken")
				}
			}
			x := &Staff{ID: newID(), Kind: "staff", Created: a.stamp(), Name: d["name"].(string), Email: d["email"].(string), Role: d["role"].(string), Auth: h}
			if err := st.addStaff(x); err != nil {
				return fail(500, "server")
			}
			return Result{201, privateStaff(x), nil}
		}),
		"POST /api/admin/staff/role": a.staffOnly("staff", func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			x := st.staff[id]
			if x == nil || x.Removed {
				return gone
			}
			to, valid := oneOf("admin", "moderator")(b["role"])
			if !valid {
				return fail(400, "role")
			}
			if err := change(st, x, func(x *Staff) { x.Role = to.(string) }); err != nil {
				return fail(500, "server")
			}
			return ok(privateStaff(x))
		}),
		"POST /api/admin/staff/remove": a.staffOnly("staff", func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			x := st.staff[id]
			if x == nil || x.Removed {
				return gone
			}
			if err := change(st, x, func(x *Staff) { x.Removed = true }); err != nil {
				return fail(500, "server")
			}
			return ok(privateStaff(x))
		}),
	}
	return a
}

// staffOnly runs fn with the store locked for writing, if the session's current role has perm.
// Signed out → 401; signed in without the permission → 403.
func (a *API) staffOnly(perm string, fn func(B, *Session) Result) handler {
	return func(b B, s *Session) Result {
		a.st.mu.Lock()
		defer a.st.mu.Unlock()
		r := a.role(s)
		if !can(r, perm) {
			if r != "" {
				return fail(403, "role")
			}
			return denied
		}
		return fn(b, s)
	}
}
