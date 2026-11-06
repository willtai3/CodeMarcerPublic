# CodeMarcer

*Pronounced "code-MAR-ser" (/koʊd ˈmɑːr.sər/). It's meant to sound like "codemancer": a magician who fixes your code problems.*

Hire a software engineer to finish, fix and ship the app you built with AI.

**Built an app with AI and need help?** Browse engineers and hire one at **https://codemarcer.com/#find**.
**Software engineer?** List your hourly rate and fixed-price packages at **https://codemarcer.com/#engineers**. Clients hire you on the site and pay you directly.

No fees, for engineers or clients. It's a straight exchange: the client pays the engineer directly and CodeMarcer takes nothing.

## Want to work on this code?

This repository is public so engineers can see how the site works. It isn't a volunteer project: paid work on it, including taking it to production (hosting with HTTPS, a managed database with backups), is hired through the site. **List yourself on the site** with your rate and packages to be considered. Please don't send unsolicited pull requests.

Found a bug? Open an issue. Found a security problem? Report it privately, see [SECURITY.md](SECURITY.md).

## How it works

- Nobody needs an account except staff.
- Engineers list themselves with their name, email and phone, a headline, skills, an hourly rate and/or up to 5 fixed-price packages, how clients pay them (Venmo, Zelle, PayPal…) and when (upfront, half and half, on completion). The listing goes live at once, and a private link to edit or remove it is emailed to them. "Email me my edit link" sends a new one (older links stop working). Staff can hide a listing.
- To hire, a client picks a package or hourly work and gives their name, email, phone number and a description of the project. They then see the engineer's email, phone and payment details, and the engineer's own email and phone are never shown before that.
- The client pays the engineer directly. CodeMarcer takes no fee and never holds money.
- Staff sign in at /admin. The owner (made with `codemarcer admin`) adds team members as **admin** (engineers, clients, hire requests) or **moderator** (hiding and showing engineers, without their contact details). Roles are checked on every request, so a change or removal applies immediately.

## Run locally

The server is one Go binary (Go 1.24+) with the pages built in. It uses only Go's standard library: no third-party packages.

```
go build -o bin/codemarcer .
DATA_DIR=./data bin/codemarcer admin   # once: choose the owner email and password
DATA_DIR=./data bin/codemarcer
```

Open http://127.0.0.1:8080 for the site and http://127.0.0.1:8080/admin for the admin page.

Running locally, emails (edit links) are printed to the server log instead of sent.

Settings (environment variables, all optional locally):
- PORT (8080), HOST (127.0.0.1), DATA_DIR (./data).
- TRUST_PROXY=1 when behind the host's HTTPS proxy (uses the proxy's address for rate limits and turns on the http→https redirect).
- SITE_URL (https://codemarcer.com): the address used in edit links.
- ACS_CONNECTION_STRING and MAIL_FROM: Azure Communication Services Email, which sends the edit links.

On Azure App Service the server refuses to start without TRUST_PROXY=1 and the two email settings.

## Code map

- `main.go` — HTTP server: security headers, staff sessions, rate limits, body limits, the built-in pages, and the `admin` command.
- `api.go` — every API route, with the role check for each.
- `rules.go` — validation of every request field, quotes and staff permissions.
- `store.go` — the records and JSON file storage (atomic writes, rolled back if a write fails).
- `auth.go` — staff password hashing and the owner account.
- `mail.go` — sending the edit-link emails (Azure Communication Services, signed with the standard library).
- `public/` — the site and admin page, plain ES modules, no build step.

## Security

Standard web setup: HTTPS from the host (TLS in transit, HSTS, `__Host-` Secure HttpOnly SameSite=Strict session cookie, http redirected to https behind the proxy) and the host's disk encryption at rest. Data is stored as plain JSON in DATA_DIR with owner-only file permissions, so anyone with access to the server can read it.

- Edit links carry a 256-bit random secret after `#`, so it isn't sent in page requests or logged. Only its SHA-256 is stored, and the page removes it from the address bar once opened. Each address gets at most one link email per 10 minutes, and listing an email that's already listed sends its link instead, with the same answer, so the form doesn't reveal who is listed.
- Staff passwords are stored only as PBKDF2-HMAC-SHA256 hashes, 600,000 rounds with a random salt; sign-in takes the same time whether or not the email exists. Hashing runs a few at a time; a request that can't get a turn within 2 seconds is answered "busy" instead of queueing.
- Replacing the owner password ends owner sessions; removing a staff member signs them out at once.
- POSTs must be JSON (32 KB max) and come from the site itself (cross-site Origin refused).
- Every text field is length-checked; control characters, Unicode direction overrides and line separators are refused, and single-line fields (names, emails) also refuse invisible characters such as zero-width spaces.
- Limits per address (IPv6 per /64): new listings and hire requests 10 accepted per hour; "email me my edit link" 10 per hour; edit-link checks 60 per 15 minutes; staff sign-in 10 tries per 15 minutes. A request takes its place before it runs, so parallel requests can't get around a limit. Staff sessions last 8 hours.
- Moderators see listings without engineers' emails, phones or payment handles.
- CI runs `gofmt`, `go vet`, `govulncheck`, the race detector on the Go tests, and a gitleaks secret scan.

Public surface: GET /, /admin (page shell only), /app.js, /admin.js, /ui.js, /styles.css, /favicon.svg, /api/engineers (public profiles only: no email or payment details); POST /api/engineers, /api/edit-link, /api/jobs, /api/admin/login, /api/admin/logout, and /api/listing, /api/listing/save, /api/listing/remove (these need the edit link). Everything else needs a signed-in staff member with the right role. `test/api.test.js` fails if this list changes.

## Tests

`npm test` builds the binary, runs the Go unit tests, then drives the real binary with API, browser and scale tests (Node 20+ and Playwright Chromium needed for those). The scale tests load 5,000 engineers and time the list, search and paging against fixed limits. `SHOTS=<folder>` saves screenshots.

## License

[PolyForm Shield 1.0.0](LICENSE): you may read, run and change this code, but not use it to offer a service that competes with CodeMarcer. It is source-available, not open source.

Required Notice: Copyright (c) 2026 William Tai
