package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// Records. JSON field names are what the pages read; `auth` never leaves the server (see the view types in api.go).

type Hash struct {
	Alg  string `json:"alg"`
	Iter int    `json:"iter"`
	Salt string `json:"salt"`
	Hash string `json:"hash"`
}

type Package struct {
	Title   string  `json:"title"`
	Price   int     `json:"price"`
	Days    int     `json:"days"`
	Details *string `json:"details"`
}

type Engineer struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	Created   string    `json:"created"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	Headline  string    `json:"headline"`
	Skills    []string  `json:"skills"`
	Rate      *int      `json:"rate"`
	Packages  []Package `json:"packages"`
	PayWith   string    `json:"payWith"`
	Terms     string    `json:"terms"`
	Portfolio *string   `json:"portfolio"`
	About     *string   `json:"about"`
	Available bool      `json:"available"`
	Hidden    bool      `json:"hidden"`
	Auth      *Hash     `json:"auth,omitempty"`
	AuthVer   int       `json:"authVer,omitempty"` // goes up on each password change or reset; older sessions stop working
}

type Staff struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Created string `json:"created"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Role    string `json:"role"`
	Removed bool   `json:"removed"`
	Auth    *Hash  `json:"auth,omitempty"`
}

type Choice struct {
	Type  string `json:"type"`
	Title string `json:"title,omitempty"`
	Days  int    `json:"days,omitempty"`
	Hours int    `json:"hours,omitempty"`
	Rate  int    `json:"rate,omitempty"`
	Quote int    `json:"quote"`
}

// A job is a client's request to one engineer. Clients have no account: their contact details live on the job.
type Job struct {
	ID          string   `json:"id"`
	Kind        string   `json:"kind"`
	Created     string   `json:"created"`
	EngineerID  string   `json:"engineerId"`
	ClientName  string   `json:"clientName"`
	ClientEmail string   `json:"clientEmail"`
	ClientPhone string   `json:"clientPhone"`
	Details     string   `json:"details"`
	Link        *string  `json:"link"`
	Choice      Choice   `json:"choice"`
	Quote       int      `json:"quote"`
	Pct         int      `json:"pct"`
	Status      string   `json:"status"`
	Amount      *int     `json:"amount"`
	Fee         *float64 `json:"fee"`
	Payout      *float64 `json:"payout"`
	Completed   *string  `json:"completed,omitempty"`
}

// Store keeps every record in memory, indexed by kind (and engineers by email), and writes the whole set to
// DATA_DIR/store.json on each change: written to a temp file, synced, then renamed, so a crash never leaves half a file.
// Callers hold mu for the whole read or change, so a check and the write that depends on it can't be split by another request.
type Store struct {
	mu        sync.RWMutex
	file      string
	version   int
	engineers map[string]*Engineer
	byEmail   map[string]*Engineer
	staff     map[string]*Staff
	jobs      map[string]*Job
	write     func(path string, data []byte) error // replaced in tests to simulate a full disk
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{file: filepath.Join(dir, "store.json"), engineers: map[string]*Engineer{}, byEmail: map[string]*Engineer{}, staff: map[string]*Staff{}, jobs: map[string]*Job{}, write: atomicWrite}
	data, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	} else if err != nil {
		return nil, err
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	for _, r := range raw {
		var head struct{ Kind string }
		if err := json.Unmarshal(r, &head); err != nil {
			return nil, err
		}
		switch head.Kind {
		case "engineer":
			e := &Engineer{}
			if err := json.Unmarshal(r, e); err != nil {
				return nil, err
			}
			s.engineers[e.ID], s.byEmail[e.Email] = e, e
		case "staff":
			x := &Staff{}
			if err := json.Unmarshal(r, x); err != nil {
				return nil, err
			}
			s.staff[x.ID] = x
		case "job":
			j := &Job{}
			if err := json.Unmarshal(r, j); err != nil {
				return nil, err
			}
			s.jobs[j.ID] = j
		}
	}
	return s, nil
}

func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	// Sync the folder too, so the rename itself survives a power cut.
	if d, err := os.Open(filepath.Dir(path)); err == nil {
		err = d.Sync()
		d.Close()
		return err
	}
	return nil
}

// commit writes the current state. If the write fails, undo puts memory back as it was (fail closed).
// Must be called with mu held for writing.
func (s *Store) commit(undo func()) error {
	all := make([]any, 0, len(s.engineers)+len(s.staff)+len(s.jobs))
	ids := map[any]string{}
	for _, e := range s.engineers {
		all, ids[e] = append(all, e), e.Created+e.ID
	}
	for _, x := range s.staff {
		all, ids[x] = append(all, x), x.Created+x.ID
	}
	for _, j := range s.jobs {
		all, ids[j] = append(all, j), j.Created+j.ID
	}
	sort.Slice(all, func(a, b int) bool { return ids[all[a]] < ids[all[b]] })
	data, err := json.Marshal(all)
	if err == nil {
		err = s.write(s.file, data)
	}
	if err != nil {
		undo()
	}
	s.version++
	return err
}

func (s *Store) addEngineer(e *Engineer) error {
	s.engineers[e.ID], s.byEmail[e.Email] = e, e
	return s.commit(func() { delete(s.engineers, e.ID); delete(s.byEmail, e.Email) })
}

func (s *Store) addStaff(x *Staff) error {
	s.staff[x.ID] = x
	return s.commit(func() { delete(s.staff, x.ID) })
}

func (s *Store) addJob(j *Job) error {
	s.jobs[j.ID] = j
	return s.commit(func() { delete(s.jobs, j.ID) })
}

// change applies fn to a record and commits; on a failed write the record is restored from a copy taken first.
func change[T any](s *Store, rec *T, fn func(*T)) error {
	before := *rec
	fn(rec)
	return s.commit(func() { *rec = before })
}
