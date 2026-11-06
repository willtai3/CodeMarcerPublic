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
	"unicode/utf8"
)

// Passwords are stored only as PBKDF2-HMAC-SHA256 hashes (600,000 rounds, OWASP's setting for PBKDF2) with a random
// 16-byte salt. Go's standard library has no scrypt or argon2, and the module proxy isn't reachable from the build
// machine, so this keeps the server free of third-party code.
const pbkdfIter = 600_000

var hashSlots = make(chan struct{}, max(2, runtime.NumCPU())) // caps concurrent hashing so a burst of sign-ins can't pin every core

func derive(pw string, salt []byte, iter int) []byte {
	hashSlots <- struct{}{}
	defer func() { <-hashSlots }()
	k, _ := pbkdf2.Key(sha256.New, pw, salt, iter, 32)
	return k
}

func hashPassword(pw string) *Hash {
	salt := make([]byte, 16)
	rand.Read(salt)
	return &Hash{Alg: "pbkdf2-sha256", Iter: pbkdfIter, Salt: hex.EncodeToString(salt), Hash: hex.EncodeToString(derive(pw, salt, pbkdfIter))}
}

var dummy = func() *Hash { return hashPassword("dummy password for timing") }()

// verifyPassword always derives a hash (a dummy one when there is no account) so the response time doesn't reveal
// which emails have accounts.
func verifyPassword(h *Hash, pw string) bool {
	if utf8.RuneCountInString(pw) > 1024 {
		return false
	}
	use := h
	if use == nil || use.Alg != "pbkdf2-sha256" || use.Iter < 100_000 {
		use = dummy
	}
	salt, err1 := hex.DecodeString(use.Salt)
	want, err2 := hex.DecodeString(use.Hash)
	got := derive(pw, salt, use.Iter)
	return h == use && err1 == nil && err2 == nil && subtle.ConstantTimeCompare(got, want) == 1
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
	data, _ := json.Marshal(owner{Email: email, Hash: *hashPassword(pw)})
	return atomicWrite(ownerFile(dir), data)
}

// ownerLogin: "setup" when no owner exists yet, "ok" for the right email and password, "" otherwise.
func ownerLogin(dir, email, pw string) string {
	data, err := os.ReadFile(ownerFile(dir))
	var o owner
	if err != nil || json.Unmarshal(data, &o) != nil {
		verifyPassword(nil, pw)
		return "setup"
	}
	if verifyPassword(&o.Hash, pw) && strings.ToLower(strings.TrimSpace(email)) == o.Email {
		return "ok"
	}
	return ""
}
