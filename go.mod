module github.com/willtai3/CodeMarcerPublic

go 1.24.7

// CI and release builds use Go 1.26.10: govulncheck reports net/http, net/textproto, crypto/tls and
// crypto/x509 fixes (GO-2026-6603 to GO-2026-6809) that earlier versions lack.
toolchain go1.26.10
