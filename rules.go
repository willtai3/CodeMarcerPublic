package main

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Request validation. Every field a request may carry is checked here, in a fixed order, and the first bad one is named.

type B = map[string]any

type check struct {
	key string
	fn  func(any) (any, bool)
}

func validate(spec []check, b B) (map[string]any, string) {
	out := make(map[string]any, len(spec))
	for _, c := range spec {
		v, ok := c.fn(b[c.key])
		if !ok {
			return nil, c.key
		}
		out[c.key] = v
	}
	return out, ""
}

// clean rejects control characters (newlines allowed only in multi-line fields) and the Unicode
// bidirectional overrides that can make one name look like another.
func clean(s string, multiline bool) bool {
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r' || r == '\t':
			if !multiline {
				return false
			}
		case r < 0x20 || r == 0x7f, r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069:
			return false
		}
	}
	return utf8.ValidString(s)
}

func strOf(min, max int, multiline bool) func(any) (any, bool) {
	return func(v any) (any, bool) {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		s = strings.TrimSpace(s)
		n := utf8.RuneCountInString(s)
		return s, n >= min && n <= max && clean(s, multiline)
	}
}

// opt makes a field optional: missing or blank becomes null.
func opt(f func(any) (any, bool)) func(any) (any, bool) {
	return func(v any) (any, bool) {
		if s, isStr := v.(string); v == nil || isStr && strings.TrimSpace(s) == "" {
			return nil, true
		}
		return f(v)
	}
}

var digits = regexp.MustCompile(`^[0-9]{1,9}$`)

// intOf accepts a whole JSON number or a string of digits ("$1,200" allowed), within [min, max].
func intOf(min, max int) func(any) (any, bool) {
	return func(v any) (any, bool) {
		var n int
		switch t := v.(type) {
		case float64:
			if t != float64(int(t)) {
				return nil, false
			}
			n = int(t)
		case string:
			s := strings.NewReplacer("$", "", ",", "").Replace(strings.TrimSpace(t))
			if !digits.MatchString(s) {
				return nil, false
			}
			n, _ = strconv.Atoi(s)
		default:
			return nil, false
		}
		return n, n >= min && n <= max
	}
}

var emailRe = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`)

func emailOf(v any) (any, bool) {
	s, ok := strOf(3, 120, false)(v)
	if !ok || !emailRe.MatchString(s.(string)) {
		return nil, false
	}
	return strings.ToLower(s.(string)), true
}

var linkRe = regexp.MustCompile(`(?i)^https://[^\s<>"]+$`)

func linkOf(v any) (any, bool) {
	s, ok := strOf(9, 200, false)(v)
	if !ok || !linkRe.MatchString(s.(string)) {
		return nil, false
	}
	u, err := url.Parse(s.(string))
	return s, err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil
}

func boolOf(v any) (any, bool) { b, ok := v.(bool); return b, ok }

func oneOf(list ...string) func(any) (any, bool) {
	return func(v any) (any, bool) {
		s, _ := v.(string)
		for _, x := range list {
			if s == x {
				return s, true
			}
		}
		return nil, false
	}
}

func passwordOf(v any) (any, bool) {
	s, ok := v.(string)
	n := utf8.RuneCountInString(s)
	return s, ok && n >= 10 && n <= 200
}

var alias = map[string]string{"node.js": "node", "nodejs": "node", "react.js": "react", "reactjs": "react", "nextjs": "next.js", "next": "next.js", "postgresql": "postgres", "js": "javascript", "ts": "typescript", "react-native": "react native"}

// tags normalises a comma list or array of skills: lower case, aliases folded, duplicates and junk dropped, at most 12.
func tags(v any) []string {
	var raw []string
	switch t := v.(type) {
	case string:
		raw = strings.Split(t, ",")
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				raw = append(raw, s)
			}
		}
	}
	out, seen := []string{}, map[string]bool{}
	for _, r := range raw {
		t := strings.Join(strings.Fields(strings.ToLower(r)), " ")
		if a, ok := alias[t]; ok {
			t = a
		}
		if t == "" || utf8.RuneCountInString(t) > 30 || !clean(t, false) || seen[t] {
			continue
		}
		seen[t] = true
		if out = append(out, t); len(out) == 12 {
			break
		}
	}
	return out
}

func skillsOf(v any) (any, bool) { t := tags(v); return t, len(t) > 0 }

var pkgSpec = []check{{"title", strOf(3, 60, false)}, {"price", intOf(25, 100000)}, {"days", intOf(1, 90)}, {"details", opt(strOf(1, 300, false))}}

func packagesOf(v any) (any, bool) {
	if s, isStr := v.(string); v == nil || isStr && s == "" {
		return []Package{}, true
	}
	list, ok := v.([]any)
	if !ok || len(list) > 5 {
		return nil, false
	}
	out := make([]Package, 0, len(list))
	for _, x := range list {
		m, ok := x.(map[string]any)
		if !ok {
			return nil, false
		}
		d, bad := validate(pkgSpec, m)
		if bad != "" {
			return nil, false
		}
		out = append(out, Package{Title: d["title"].(string), Price: d["price"].(int), Days: d["days"].(int), Details: strPtr(d["details"])})
	}
	return out, true
}

var terms = []string{"Upfront", "Half upfront, half on completion", "On completion", "Discuss with client"}

var profileSpec = []check{{"name", strOf(1, 80, false)}, {"headline", strOf(5, 80, false)}, {"skills", skillsOf}, {"rate", opt(intOf(10, 1000))}, {"packages", packagesOf}, {"payWith", strOf(3, 200, false)}, {"terms", oneOf(terms...)}, {"portfolio", opt(linkOf)}, {"about", opt(strOf(1, 1000, true))}, {"available", boolOf}}
var signupSpec = append([]check{profileSpec[0], {"email", emailOf}, {"password", passwordOf}}, profileSpec[1:]...)
var jobSpec = []check{{"details", strOf(10, 2000, true)}, {"link", opt(linkOf)}}
var clientSpec = []check{{"clientName", strOf(1, 80, false)}, {"clientEmail", emailOf}, {"password", passwordOf}}
var clientEditSpec = []check{{"name", strOf(1, 80, false)}}
var staffSpec = []check{{"name", strOf(1, 80, false)}, {"email", emailOf}, {"password", passwordOf}, {"role", oneOf("admin", "moderator")}}

// What each staff role may do. The owner is the account made with `codemarcer admin`.
var perms = map[string][]string{"owner": {"moderate", "accounts", "money", "staff"}, "admin": {"moderate", "accounts", "money"}, "moderator": {"moderate"}}

func can(role, perm string) bool {
	for _, p := range perms[role] {
		if p == perm {
			return true
		}
	}
	return false
}

// Jobs move forward only: the engineer accepts or declines, then marks paid and complete; the client can cancel before it's accepted.
var next = map[string][]string{"requested": {"accepted", "declined"}, "accepted": {"paid", "complete", "declined"}, "paid": {"complete"}}
var clientNext = map[string][]string{"requested": {"cancelled"}}

func allowed(table map[string][]string, from, to string) bool {
	for _, s := range table[from] {
		if s == to {
			return true
		}
	}
	return false
}

// profileOf validates an engineer profile; it needs an hourly rate, at least one package, or both.
func profileOf(b B, signup bool) (*Engineer, string, string) {
	spec := profileSpec
	if signup {
		spec = signupSpec
	}
	d, bad := validate(spec, b)
	if bad != "" {
		return nil, "", bad
	}
	e := &Engineer{Name: d["name"].(string), Headline: d["headline"].(string), Skills: d["skills"].([]string), Rate: intPtr(d["rate"]), Packages: d["packages"].([]Package), PayWith: d["payWith"].(string), Terms: d["terms"].(string), Portfolio: strPtr(d["portfolio"]), About: strPtr(d["about"]), Available: d["available"].(bool)}
	if e.Rate == nil && len(e.Packages) == 0 {
		return nil, "", "pricing"
	}
	pw := ""
	if signup {
		e.Email, pw = d["email"].(string), d["password"].(string)
	}
	return e, pw, ""
}

var pkgChoice = regexp.MustCompile(`^p([0-4])$`)

// quoteFor: "p0".."p4" picks a package, "hourly" needs a rate and 1-500 estimated hours.
func quoteFor(e *Engineer, choice any, hours any) *Choice {
	c, _ := choice.(string)
	if c == "hourly" {
		h, ok := intOf(1, 500)(hours)
		if e.Rate == nil || !ok {
			return nil
		}
		return &Choice{Type: "hourly", Hours: h.(int), Rate: *e.Rate, Quote: h.(int) * *e.Rate}
	}
	m := pkgChoice.FindStringSubmatch(c)
	if m == nil {
		return nil
	}
	i, _ := strconv.Atoi(m[1])
	if i >= len(e.Packages) {
		return nil
	}
	p := e.Packages[i]
	return &Choice{Type: "package", Title: p.Title, Days: p.Days, Quote: p.Price}
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func intPtr(v any) *int {
	if n, ok := v.(int); ok {
		return &n
	}
	return nil
}
