# CodeMarcer

*Pronounced "code-MAR-ser" (/koʊd ˈmɑːr.sər/). It's meant to sound like "codemancer": a magician who fixes your code problems.*

Hire a software engineer to finish, fix and ship the app you built with AI.

**Built an app with AI and need help?** Browse engineers and hire one at **https://codemarcer.com/#find**.
**Software engineer?** List your hourly rate and fixed-price packages at **https://codemarcer.com/#engineers**. Clients hire you on the site and pay you directly.

No fees on any job requested before February 1, 2027. After that, engineers pay 10% of each completed job.

## Want to work on this code?

This repository is public so engineers can see how the site works. It isn't a volunteer project: paid work on it, including taking it to production (hosting with HTTPS, a managed database with backups, email notifications and fee payments), is hired through the site. **List yourself on the site** with your rate and packages to be considered. Please don't send unsolicited pull requests.

Found a bug? Open an issue. Found a security problem? Report it privately, see [SECURITY.md](SECURITY.md).

## How it works

- Clients don't need an account. To hire, they pick a package or hourly work and give their name, email, phone number and a description of the project. Only then are the engineer's email and payment details shown to them.
- Engineers sign up with a headline, skills, an hourly rate and/or up to 5 fixed-price packages, how clients pay them (Venmo, Zelle, PayPal…) and when (upfront, half and half, on completion). Profiles go live at once; staff can hide one.
- The client pays the engineer directly. CodeMarcer never holds money. The engineer contacts the client, accepts or declines, marks the job paid and complete, and enters the final amount.
- Staff sign in at /admin. The owner (made with `codemarcer admin`) adds team members as **admin** (engineers, clients, jobs, setting temporary engineer passwords) or **moderator** (hiding and showing engineers only). Roles are checked on every request, so a change or removal applies immediately.
- The fee rate is fixed when the client sends the request: 0% before Feb 1, 2027 00:00 Pacific, then 10% of the final amount, which the engineer owes CodeMarcer. `fees.go` holds the rule for the server and `public/fees.js` for the page; a test fails if they differ.

## Run locally

The server is one Go binary (Go 1.24+) with the pages built in. It uses only Go's standard library: no third-party packages.

```
go build -o bin/codemarcer .
DATA_DIR=./data bin/codemarcer admin   # once: choose the owner email and password
DATA_DIR=./data bin/codemarcer
```

Open http://127.0.0.1:8080 for the site and http://127.0.0.1:8080/admin for the admin page.

Settings (environment variables, all optional): PORT (8080), HOST (127.0.0.1), DATA_DIR (./data), TRUST_PROXY=1 when behind the host's HTTPS proxy (uses the proxy's address for rate limits and turns on the http→https redirect).

## Code map

- `main.go` — HTTP server: security headers, sessions, rate limits, body limits, the built-in pages, and the `admin` command.
- `api.go` — every API route, with the role check for each.
- `rules.go` — validation of every request field, quotes, job status rules and staff permissions.
- `store.go` — the records and JSON file storage (atomic writes, rolled back if a write fails).
- `auth.go` — password hashing and the owner account.
- `fees.go` — fee rules.
- `public/` — the site and admin page, plain ES modules, no build step.

## Security

Standard web setup: HTTPS from the host (TLS in transit, HSTS, `__Host-` Secure HttpOnly SameSite=Strict session cookie, http redirected to https behind the proxy) and the host's disk encryption at rest. Data is stored as plain JSON in DATA_DIR with owner-only file permissions, so anyone with access to the server can read it.

- Passwords are stored only as PBKDF2-HMAC-SHA256 hashes, 600,000 rounds with a random salt; sign-in takes the same time whether or not the email exists.
- POSTs must be JSON (32 KB max) and come from the site itself (cross-site Origin refused).
- Every text field is length-checked; control characters and Unicode direction overrides are refused.
- Sign-in is limited to 10 tries per 15 minutes per address, new listings and hire requests to 10 per hour, and sessions last 8 hours.
- CI runs `gofmt`, `go vet`, `govulncheck`, the race detector on the Go tests, and a gitleaks secret scan.

Public surface: GET /, /admin (page shell only), /app.js, /admin.js, /ui.js, /fees.js, /styles.css, /favicon.svg, /api/engineers (public profiles only: no email or payment details), /api/pricing; POST /api/engineers, /api/login, /api/logout, /api/jobs, /api/admin/login, /api/admin/logout. Everything else needs a signed-in engineer or staff member with the right role. `test/api.test.js` fails if this list changes.

## Tests

`npm test` builds the binary, runs the Go unit tests, then drives the real binary with API, browser and scale tests (Node 20+ and Playwright Chromium needed for those). The scale tests load 5,000 engineers and time the list, search and paging against fixed limits. `SHOTS=<folder>` saves screenshots.

## License

[PolyForm Shield 1.0.0](LICENSE): you may read, run and change this code, but not use it to offer a service that competes with CodeMarcer. It is source-available, not open source.

Required Notice: Copyright (c) 2026 William Tai
