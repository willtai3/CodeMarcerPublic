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
	sending map[string]bool // addresses with a link email on its way
	sentAt  []time.Time     // emails sent in the last hour
	work    sync.WaitGroup  // email work still running after its reply (tests wait for it)
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

// mailGap: an address gets at most one link per gap, so the forms can't flood someone's inbox. The time is kept on the
// listing, so a restart doesn't reset it.
const mailGap = 10 * time.Minute

// linkLife: an edit link stops working after this; "Email me my edit link" sends a new one.
const linkLife = 30 * 24 * time.Hour

// The email service allows 100 emails an hour on a verified domain. The site stays under that, and stops sending
// request emails earlier so edit links still get through.
const (
	mailPerHour    = 90
	requestPerHour = 60
	mailPerMinute  = 25
)

// linkMail: a new edit link for e and the email that carries it, plus the key to store once the email has gone out.
// nil when this address was sent a link within mailGap or one is being sent now. Call with st.mu held.
// later runs f after the reply, outside the store lock: email can be slow, and its timing mustn't show in the answer.
func (a *API) later(f func()) {
	a.work.Add(1)
	go func() { defer a.work.Done(); f() }()
}

func (a *API) linkMail(e *Engineer, fresh bool) (*mail, string) {
	if t, err := time.Parse(time.RFC3339, e.LinkSent); err == nil && !fresh && a.now().Sub(t) < mailGap {
		return nil, ""
	}
	a.mailMu.Lock()
	defer a.mailMu.Unlock()
	if a.sending[e.Email] {
		return nil, ""
	}
	a.sending[e.Email] = true
	secret := make([]byte, 32)
	rand.Read(secret)
	token := base64.RawURLEncoding.EncodeToString(secret)
	subject, text := editMail(a.site+"/#edit="+e.ID+"."+token, a.site+"/e/"+e.Slug, fresh || e.Pending)
	return &mail{e.Email, subject, text}, keyOf(token)
}

// deliverLink sends a link email and only then stores its key, so a failed email leaves the old link working and the
// address free to ask again.
func (a *API) deliverLink(id string, m *mail, key string) {
	sent := a.sendWithin(m, mailPerHour)
	a.st.mu.Lock()
	if e := a.st.engineers[id]; sent && e != nil && e.Email == m.to {
		if err := change(a.st, e, func(e *Engineer) { e.EditKey, e.LinkSent = key, a.now().UTC().Format(time.RFC3339) }); err != nil {
			log.Printf("edit link emailed but not saved: %v", err)
		}
	}
	a.st.mu.Unlock()
	a.mailMu.Lock()
	delete(a.sending, m.to)
	a.mailMu.Unlock()
}

// sendWithin sends m unless the site has sent `limit` emails in the last hour (or mailPerMinute in the last minute).
func (a *API) sendWithin(m *mail, limit int) bool {
	a.mailMu.Lock()
	now, hour, minute := a.now(), []time.Time{}, 0
	for _, t := range a.sentAt {
		if now.Sub(t) < time.Hour {
			hour = append(hour, t)
			if now.Sub(t) < time.Minute {
				minute++
			}
		}
	}
	a.sentAt = hour
	if len(hour) >= limit || minute >= mailPerMinute {
		a.mailMu.Unlock()
		log.Printf("email to %s held back: the site's hourly email limit is reached", m.to)
		return false
	}
	a.sentAt = append(a.sentAt, now)
	a.mailMu.Unlock()
	if err := a.mail.Send(m.to, m.subject, m.text); err != nil {
		log.Printf("email not sent: %v", err)
		return false
	}
	return true
}

// requestsPerDay: hire requests per engineer per 24 hours. It bounds how fast anyone can collect an engineer's contact
// details and how many emails they get.
const requestsPerDay = 20

func (a *API) requestsToday(e *Engineer) int {
	n, since := 0, a.now().Add(-24*time.Hour).UTC().Format("2006-01-02T15:04:05.000Z")
	for _, j := range a.st.jobs {
		if j.EngineerID == e.ID && j.Created > since {
			n++
		}
	}
	return n
}

// requestMail tells the engineer about a new request.
func (a *API) requestMail(e *Engineer, j *Job) *mail {
	what := fmt.Sprintf("%s ($%d, about %d day%s)", j.Choice.Title, j.Quote, j.Choice.Days, map[bool]string{true: "s"}[j.Choice.Days != 1])
	if j.Choice.Type == "hourly" {
		what = fmt.Sprintf("Hourly work, about %d hour%s ($%d at $%d/hour)", j.Choice.Hours, map[bool]string{true: "s"}[j.Choice.Hours != 1], j.Quote, j.Choice.Rate)
	}
	link := ""
	if j.Link != nil && *j.Link != "" {
		link = "Link: " + *j.Link + "\n"
	}
	return &mail{e.Email, "New request on CodeMarcer from " + j.ClientName, fmt.Sprintf("Hi %s,\n\n%s sent you a request on CodeMarcer.\n\nWhat: %s\nName: %s\nEmail: %s\nPhone: %s\n%s\nWhat they need:\n%s\n\nThey also have your email and phone. Contact them to agree the details; CodeMarcer doesn't handle payments.\n\nTo pause or change your listing, use your private edit link, or \"Email me my edit link\" on the For engineers tab of %s.\n", e.Name, j.ClientName, what, j.ClientName, j.ClientEmail, j.ClientPhone, link, j.Details, a.site)}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// profilePage: the name and headline for /e/<slug>, for the page title and link previews. Call with st.mu held.
func (a *API) profilePage(slug string) (name, headline string, found bool) {
	for _, p := range a.directory() {
		if p.Slug == slug {
			return p.Name, p.Headline, true
		}
	}
	return "", "", false
}

func keyOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// byLink finds the engineer whose edit link is in b["key"]. Call with st.mu held.
func (a *API) byLink(b B) *Engineer {
	key, _ := b["key"].(string)
	id, token, _ := strings.Cut(key, ".")
	e := a.st.engineers[id]
	if e == nil || e.EditKey == "" || len(token) != 43 || subtle.ConstantTimeCompare([]byte(keyOf(token)), []byte(e.EditKey)) != 1 {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, e.LinkSent); err != nil || a.now().Sub(t) > linkLife {
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
	Verified  bool      `json:"verified"`
	Slug      string    `json:"slug"`
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
		if !e.Hidden && !e.Pending {
			list = append(list, publicProfile{e.ID, e.Name, e.Headline, e.Skills, e.Rate, e.Packages, e.Terms, e.Portfolio, e.About, e.Available, e.Verified, e.Slug, e.Created})
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
	a := &API{mail: m, site: strings.TrimRight(site, "/"), sending: map[string]bool{}, st: st, now: time.Now, dataDir: dataDir}
	a.routes = map[string]handler{
		"GET /api/engineers": func(b B, s *Session) Result {
			st.mu.RLock()
			defer st.mu.RUnlock()
			return ok(a.directory())
		},

		// A new listing waits, unseen, until the engineer opens the emailed link and publishes it: that proves the
		// email is theirs, so nobody can list someone else's address with their own phone and payment details. Until
		// then the latest details sent for that email win. An email that is already published gets a new link
		// instead. The answer is always the same and comes before any email is sent, so neither its content nor its
		// timing shows who is listed.
		"POST /api/engineers": func(b B, s *Session) Result {
			e, bad := profileOf(b, true)
			if bad != "" {
				return fail(400, bad)
			}
			st.mu.Lock()
			defer st.mu.Unlock()
			to, fresh := st.byEmail[e.Email], false
			switch {
			case to == nil:
				e.ID, e.Kind, e.Created, e.Pending, e.Hidden = newID(), "engineer", a.stamp(), true, st.blocked[e.Email] != nil
				e.Slug = st.slugFor(e.Name, e.ID)
				if err := st.addEngineer(e); err != nil {
					return fail(500, "server")
				}
				to, fresh = e, true
			case to.Pending:
				if err := change(st, to, func(t *Engineer) {
					t.Name, t.Phone, t.Headline, t.Skills, t.Rate, t.Packages, t.PayWith, t.Terms, t.Portfolio, t.About, t.Available = e.Name, e.Phone, e.Headline, e.Skills, e.Rate, e.Packages, e.PayWith, e.Terms, e.Portfolio, e.About, e.Available
				}); err != nil {
					return fail(500, "server")
				}
			}
			if m, key := a.linkMail(to, fresh); m != nil {
				id := to.ID
				a.later(func() { a.deliverLink(id, m, key) })
			}
			return Result{201, map[string]bool{"ok": true}, nil}
		},
		// "Email me my edit link": the same answer whether or not the email is listed.
		"POST /api/edit-link": func(b B, s *Session) Result {
			email, valid := emailOf(b["email"])
			if !valid {
				return fail(400, "email")
			}
			st.mu.Lock()
			defer st.mu.Unlock()
			if e := st.byEmail[email.(string)]; e != nil {
				if m, key := a.linkMail(e, false); m != nil {
					id := e.ID
					a.later(func() { a.deliverLink(id, m, key) })
				}
			}
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
			// The email, the hidden flag, the id and the public address can't be set from here. A new name or portfolio
			// needs checking again, so it clears Verified.
			if err := change(st, e, func(e *Engineer) {
				e.Verified = e.Verified && e.Name == upd.Name && fmt.Sprint(deref(e.Portfolio)) == fmt.Sprint(deref(upd.Portfolio))
				e.Pending = false // saving from the emailed link publishes the listing
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
			if err := st.removeEngineer(e, a.stamp()); err != nil {
				return fail(500, "server")
			}
			return ok(map[string]bool{"ok": true})
		},

		// A hire request needs no account: name, email, phone and a description of the project. The client then gets the
		// engineer's email, phone and payment details and contacts them directly.
		"POST /api/jobs": func(b B, s *Session) Result {
			id, _ := b["engineerId"].(string)
			res, m := func() (Result, *mail) {
				st.mu.Lock()
				defer st.mu.Unlock()
				e := st.engineers[id]
				if e == nil || e.Hidden || e.Pending || !e.Available {
					return fail(404, "engineer"), nil
				}
				if a.requestsToday(e) >= requestsPerDay {
					return fail(429, "engineer-busy"), nil
				}
				c := quoteFor(e, b["choice"], b["hours"])
				if c == nil {
					if b["choice"] == "hourly" {
						return fail(400, "hours"), nil
					}
					return fail(400, "choice"), nil
				}
				d, bad := validate(hireSpec, b)
				if bad != "" {
					return fail(400, bad), nil
				}
				j := &Job{ID: newID(), Kind: "job", Created: a.stamp(), EngineerID: e.ID, ClientName: d["clientName"].(string), ClientEmail: d["clientEmail"].(string), ClientPhone: d["clientPhone"].(string), Details: d["details"].(string), Link: strPtr(d["link"]), Choice: *c, Quote: c.Quote}
				if err := st.addJob(j); err != nil {
					return fail(500, "server"), nil
				}
				return Result{201, map[string]any{"engineer": map[string]string{"name": e.Name, "email": e.Email, "phone": e.Phone, "payWith": e.PayWith, "terms": e.Terms}, "quote": c.Quote}, nil}, a.requestMail(e, j)
			}()
			if m != nil { // the client already has the engineer's details, so a held-back or failed email doesn't fail the request
				a.later(func() { a.sendWithin(m, requestPerHour) })
			}
			return res
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
			if !hidden {
				if err := st.unblock(e.Email); err != nil {
					return fail(500, "server")
				}
			}
			return ok(map[string]bool{"ok": true})
		}),
		"POST /api/admin/verify": a.staffOnly("moderate", func(b B, s *Session) Result {
			id, _ := b["id"].(string)
			verified, isBool := b["verified"].(bool)
			e := st.engineers[id]
			if e == nil {
				return gone
			}
			if !isBool {
				return fail(400, "verified")
			}
			if err := change(st, e, func(e *Engineer) { e.Verified = verified }); err != nil {
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
