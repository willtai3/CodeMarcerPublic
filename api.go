package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// Every API route: (body, session) → (status, JSON value, session change).
// Only staff sign in: the owner (made with `codemarcer admin`) and team members as "admin" or "moderator". A session's
// role is re-read on every request, so a removed or demoted member loses access at once. Nobody else has an account:
// engineers edit their listing with a private link sent to their email, and a hire request carries the client's
// name, email and phone.

type Session struct {
	Role string    // "owner" or "staff"
	ID   string    // staff id
	Ver  string    // owner sessions: the owner password version they were made with
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
	mail    Mailer
	site    string // the site's address, for edit links
	mailMu  sync.Mutex
	mailed  map[string]time.Time // when each address was last sent a link
	st      *Store
	now     func() time.Time
	dataDir string
	routes  map[string]handler
	pubMu   sync.Mutex // guards public: many readers of the store can ask for the directory at once
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
	denied  = fail(401, "auth")
	gone    = fail(404, "not found")
	busy    = fail(503, "busy") // every password-hashing slot stayed taken; try again shortly
	badLink = fail(401, "key")
)

// An edit link is the site address + "/#edit=" + the engineer id + "." + a 256-bit secret. Only the secret's SHA-256
// is stored, and the part after # is never sent in requests, so it stays out of server logs.
type mail struct{ to, subject, text string }

// mailGap: an address gets at most one link per gap, so the form can't be used to flood someone's inbox.
const mailGap = 10 * time.Minute

// newLink makes a new edit link for e (the old one stops working) and the email that carries it; nil when this address
// was sent a link too recently. Call with st.mu held for writing.
func (a *API) newLink(e *Engineer, fresh bool) (*mail, error) {
	a.mailMu.Lock()
	now := a.now()
	if last, seen := a.mailed[e.Email]; seen && !fresh && now.Sub(last) < mailGap {
		a.mailMu.Unlock()
		return nil, nil
	}
	a.mailed[e.Email] = now
	a.mailMu.Unlock()
	secret := make([]byte, 32)
	rand.Read(secret)
	token := base64.RawURLEncoding.EncodeToString(secret)
	if err := change(a.st, e, func(e *Engineer) { e.EditKey = keyOf(token) }); err != nil {
		return nil, err
	}
	subject, text := editMail(e.Name, a.site+"/#edit="+e.ID+"."+token, fresh)
	return &mail{e.Email, subject, text}, nil
}

func keyOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// send delivers m outside the store lock; false when the email service refused it.
func (a *API) send(m *mail) bool {
	if m == nil {
		return true
	}
	if err := a.mail.Send(m.to, m.subject, m.text); err != nil {
		log.Printf("edit link email not sent: %v", err)
		return false
	}
	return true
}

// byLink finds the engineer whose edit link is in b["key"]. Call with st.mu held.
func (a *API) byLink(b B) *Engineer {
	key, _ := b["key"].(string)
	id, token, _ := strings.Cut(key, ".")
	e := a.st.engineers[id]
	if e == nil || e.EditKey == "" || len(token) != 43 || subtle.ConstantTimeCompare([]byte(keyOf(token)), []byte(e.EditKey)) != 1 {
		return nil
	}
	return e
}

func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (a *API) stamp() string { return a.now().UTC().Format("2006-01-02T15:04:05.000Z") }

// role resolves a session to its current role, or "" when it no longer grants anything. Call with st.mu held.
func (a *API) role(s *Session) string {
	switch {
	case s == nil:
		return ""
	case s.Role == "owner":
		if s.Ver != "" && s.Ver == ownerVersion(a.dataDir) {
			return "owner"
		}
	case s.Role == "staff":
		if x := a.st.staff[s.ID]; x != nil && !x.Removed {
			return x.Role
		}
	}
	return ""
}

// Views: what each audience may see. `auth` and `editKey` are never included.

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

func private(e *Engineer) Engineer { c := *e; c.EditKey = ""; return c }
func privateStaff(x *Staff) Staff  { c := *x; c.Auth = nil; return c }

func newestFirst[T any](list []T, created func(T) string) []T {
	sort.SliceStable(list, func(i, j int) bool { return created(list[i]) > created(list[j]) })
	return list
}

// directory is the public list: hidden engineers left out, available ones first, newest first.
// It is rebuilt only when the store changes. Call with st.mu held for reading.
func (a *API) directory() []publicProfile {
	a.pubMu.Lock()
	defer a.pubMu.Unlock()
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

var hireSpec = []check{{"clientName", strOf(1, 80, false)}, {"clientEmail", emailOf}, {"clientPhone", phoneOf}, {"details", strOf(10, 2000, true)}, {"link", opt(linkOf)}}

func NewAPI(st *Store, dataDir string, m Mailer, site string) *API {
	a := &API{mail: m, site: strings.TrimRight(site, "/"), mailed: map[string]time.Time{}, st: st, now: time.Now, dataDir: dataDir}
	a.routes = map[string]handler{
		"GET /api/engineers": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			return ok(a.directory())
		},

		// A new listing goes live at once; the engineer gets a private edit link by email. An email that is already
		// listed gets a fresh link instead, with the same answer, so the form doesn't reveal who is listed.
		"POST /api/engineers": func(b B, s *Session) Result {
			e, bad := profileOf(b, true)
			if bad != "" {
				return fail(400, bad)
			}
			st.mu.Lock()
			to, fresh := st.byEmail[e.Email], false
			if to == nil {
				e.ID, e.Kind, e.Created = newID(), "engineer", a.stamp()
				if err := st.addEngineer(e); err != nil {
					st.mu.Unlock()
					return fail(500, "server")
				}
				to, fresh = e, true
			}
			m, err := a.newLink(to, fresh)
			st.mu.Unlock()
			if err != nil {
				return fail(500, "server")
			}
			return Result{201, map[string]bool{"sent": a.send(m)}, nil}
		},
		// "Email me my edit link": the same answer whether or not the email is listed.
		"POST /api/edit-link": func(b B, s *Session) Result {
			email, valid := emailOf(b["email"])
			if !valid {
				return fail(400, "email")
			}
			st.mu.Lock()
			var m *mail
			var err error
			if e := st.byEmail[email.(string)]; e != nil {
				m, err = a.newLink(e, false)
			}
			st.mu.Unlock()
			if err != nil {
				return fail(500, "server")
			}
			a.send(m)
			return ok(map[string]bool{"ok": true})
		},
		"POST /api/listing": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			if e := a.byLink(b); e != nil {
				return ok(private(e))
			}
			return badLink
		},
		"POST /api/listing/save": func(b B, s *Session) Result {
			st.mu.RLock()
			known := a.byLink(b) != nil
			st.mu.RUnlock()
			if !known { // a wrong link learns nothing about validation
				return badLink
			}
			upd, bad := profileOf(b, false)
			if bad != "" {
				return fail(400, bad)
			}
			st.mu.Lock()
			defer st.mu.Unlock()
			e := a.byLink(b)
			if e == nil {
				return badLink
			}
			// The email, the hidden flag and the id can't be set from here.
			if err := change(st, e, func(e *Engineer) {
				e.Name, e.Phone, e.Headline, e.Skills, e.Rate, e.Packages, e.PayWith, e.Terms, e.Portfolio, e.About, e.Available = upd.Name, upd.Phone, upd.Headline, upd.Skills, upd.Rate, upd.Packages, upd.PayWith, upd.Terms, upd.Portfolio, upd.About, upd.Available
			}); err != nil {
				return fail(500, "server")
			}
			return ok(private(e))
		},
		"POST /api/listing/remove": func(b B, s *Session) Result {
			st.mu.Lock()
			defer st.mu.Unlock()
			e := a.byLink(b)
			if e == nil {
				return badLink
			}
			if err := st.removeEngineer(e); err != nil {
				return fail(500, "server")
			}
			return ok(map[string]bool{"ok": true})
		},

		// A hire request needs no account: name, email, phone and a description of the project. The client then gets the
		// engineer's email, phone and payment details and contacts them directly.
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
			j := &Job{ID: newID(), Kind: "job", Created: a.stamp(), EngineerID: e.ID, ClientName: d["clientName"].(string), ClientEmail: d["clientEmail"].(string), ClientPhone: d["clientPhone"].(string), Details: d["details"].(string), Link: strPtr(d["link"]), Choice: *c, Quote: c.Quote}
			if err := st.addJob(j); err != nil {
				return fail(500, "server")
			}
			return Result{201, map[string]any{"engineer": map[string]string{"name": e.Name, "email": e.Email, "phone": e.Phone, "payWith": e.PayWith, "terms": e.Terms}, "quote": c.Quote}, nil}
		},

		"POST /api/admin/login": func(b B, s *Session) Result {
			email, _ := b["email"].(string)
			pw, _ := b["password"].(string)
			o, ver, err := ownerLogin(a.dataDir, email, pw)
			if err != nil {
				return busy
			}
			if o == "ok" {
				return Result{200, map[string]string{"role": "owner"}, &Change{Login: &Session{Role: "owner", Ver: ver}}}
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
				good, err := verifyPassword(h, pw)
				if err != nil {
					return busy
				}
				if good && m != nil {
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
				row := engRow{private(e), count[e.ID]}
				if !can(r, "accounts") { // moderators hide and show listings; they don't need contact or payment details
					row.Email, row.Phone, row.PayWith = "", "", ""
				}
				engineers = append(engineers, row)
			}
			out := map[string]any{"me": map[string]any{"role": r, "perms": perms[r]}, "engineers": newestFirst(engineers, func(e engRow) string { return e.Created })}
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
					Job             // a copy: the reply is written after the lock is released
					Engineer string `json:"engineer"`
				}
				rows := make([]jobRow, 0, len(jobs))
				for _, j := range jobs {
					name := "(removed)"
					if e := st.engineers[j.EngineerID]; e != nil {
						name = e.Name
					}
					rows = append(rows, jobRow{*j, name})
				}
				out["jobs"] = rows
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
			return ok(map[string]bool{"ok": true})
		}),
		"POST /api/admin/staff": a.staffOnly("staff", func(b B, s *Session) Result {
			d, bad := validate(staffSpec, b)
			if bad != "" {
				return fail(400, bad)
			}
			st.mu.Unlock() // hash outside the lock, then re-take it and re-check the role
			h, err := hashPassword(d["password"].(string))
			st.mu.Lock()
			if err != nil {
				return busy
			}
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
