package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

// Passwords are stored only as PBKDF2-HMAC-SHA256 hashes (600,000 rounds, OWASP's setting for PBKDF2) with a random
// 16-byte salt. Go's standard library has no scrypt or argon2, and the module proxy isn't reachable from the build
// machine, so this keeps the server free of third-party code.
const pbkdfIter = 600_000

var hashSlots = make(chan struct{}, max(2, runtime.NumCPU())) // caps concurrent hashing so a burst of sign-ins can't pin every core

// slotWait: how long a request waits for a free hashing slot before it is answered 503 "busy". Without a limit, a
// flood of hashing requests queues every later sign-in behind it.
var slotWait = 2 * time.Second

var errBusy = errors.New("busy")

func derive(pw string, salt []byte, iter int) ([]byte, error) {
	t := time.NewTimer(slotWait)
	defer t.Stop()
	select {
	case hashSlots <- struct{}{}:
	case <-t.C:
		return nil, errBusy
	}
	defer func() { <-hashSlots }()
	k, _ := pbkdf2.Key(sha256.New, pw, salt, iter, 32)
	return k, nil
}

func hashPassword(pw string) (*Hash, error) {
	salt := make([]byte, 16)
	rand.Read(salt)
	k, err := derive(pw, salt, pbkdfIter)
	if err != nil {
		return nil, err
	}
	return &Hash{Alg: "pbkdf2-sha256", Iter: pbkdfIter, Salt: hex.EncodeToString(salt), Hash: hex.EncodeToString(k)}, nil
}

var dummy = func() *Hash { h, _ := hashPassword("dummy password for timing"); return h }()

// verifyPassword always derives a hash (a dummy one when there is no account) so the response time doesn't reveal
// which emails have accounts.
func verifyPassword(h *Hash, pw string) (bool, error) {
	if utf8.RuneCountInString(pw) > 1024 {
		return false, nil
	}
	use := h
	if use == nil || use.Alg != "pbkdf2-sha256" || use.Iter < 100_000 {
		use = dummy
	}
	salt, err1 := hex.DecodeString(use.Salt)
	want, err2 := hex.DecodeString(use.Hash)
	got, err := derive(pw, salt, use.Iter)
	if err != nil {
		return false, err
	}
	return h == use && err1 == nil && err2 == nil && subtle.ConstantTimeCompare(got, want) == 1, nil
}

// The owner account lives in DATA_DIR/admin.json, made with `codemarcer admin` on the server.
type owner struct {
	Email string `json:"email"`
	Hash
}

func ownerFile(dir string) string { return filepath.Join(dir, "admin.json") }

func setOwner(dir, email, pw string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	if _, ok := emailOf(email); !ok {
		return errors.New("That email is not valid.")
	}
	if utf8.RuneCountInString(pw) < 12 {
		return errors.New("Use a password of at least 12 characters.")
	}
	if utf8.RuneCountInString(pw) > 200 {
		return errors.New("Use a password of at most 200 characters.")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	h, err := hashPassword(pw)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(owner{Email: email, Hash: *h})
	return atomicWrite(ownerFile(dir), data)
}

func readOwner(dir string) *owner {
	data, err := os.ReadFile(ownerFile(dir))
	var o owner
	if err != nil || json.Unmarshal(data, &o) != nil {
		return nil
	}
	return &o
}

// ownerVersion identifies the current owner password: a new one (from `codemarcer admin`) has a new salt, so owner
// sessions made before it stop working. "" when there is no owner.
func ownerVersion(dir string) string {
	if o := readOwner(dir); o != nil {
		return o.Salt
	}
	return ""
}

// ownerLogin: "setup" when no owner exists yet, "ok" for the right email and password, "" otherwise; and the owner
// version to keep in the session.
func ownerLogin(dir, email, pw string) (string, string, error) {
	o := readOwner(dir)
	if o == nil {
		_, err := verifyPassword(nil, pw)
		return "setup", "", err
	}
	good, err := verifyPassword(&o.Hash, pw)
	if good && strings.ToLower(strings.TrimSpace(email)) == o.Email {
		return "ok", o.Salt, nil
	}
	return "", "", err
}
