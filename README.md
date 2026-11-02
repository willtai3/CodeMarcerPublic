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

- Clients get an account when they send their first request. They follow their requests on the site, can cancel one before it's accepted, and confirm or dispute the final amount when the job is complete.
- Engineers sign up with a headline, skills, an hourly rate and/or up to 5 fixed-price packages, how clients pay them (Venmo, Zelle, PayPal…) and when (upfront, half and half, on completion). Profiles go live at once; the admin can hide one.
- A client picks a package or hourly work and sends a request. Only then are the engineer's email and payment details shown to that client.
- The client pays the engineer directly. CodeMarcer never holds money. The engineer accepts or declines, marks the job paid and complete, and enters the final amount.
- Staff sign in at /admin. The owner (made with `npm run admin`) adds team members as **admin** (engineers, clients, jobs, setting temporary passwords) or **moderator** (hiding and showing engineers only). Roles are checked on every request, so a change or removal applies immediately.
- The fee rate is fixed when the client sends the request: 0% before Feb 1, 2027 00:00 Pacific, then 10% of the final amount, which the engineer owes CodeMarcer. `public/fees.js` is the only place the rule lives.

## Run locally

One small Node server, no runtime dependencies, Node 20+.

```
npm run admin     # once: choose the owner email and password
npm start
```

Open http://127.0.0.1:8080 for the site and http://127.0.0.1:8080/admin for the admin page.

Settings (environment variables, all optional): PORT (8080), HOST (127.0.0.1), DATA_DIR (./data), TRUST_PROXY=1 when behind the host's HTTPS proxy (also turns on the http→https redirect).

## Code map

- `lib/api.js` — every API route as a plain function. The server and the in-browser demo run this same code.
- `lib/rules.js` — validation, quotes, job status rules and the public profile view.
- `lib/auth.js` — scrypt password hashes for engineers and the admin.
- `lib/store.js` — JSON file storage with atomic writes.
- `server.js` — HTTP, security headers, sessions, rate limits.
- `public/` — the site and admin page, plain ES modules, no build step.

## Security

Standard web setup: HTTPS from the host (TLS in transit, HSTS, Secure HttpOnly SameSite=Strict cookies, http redirected to https behind the proxy) and the host's disk encryption at rest. Data is stored as plain JSON in DATA_DIR with owner-only file permissions, so anyone with access to the server can read it. Passwords are stored only as scrypt hashes. Sign-in is limited to 10 tries per 15 minutes per connection, new listings and hire requests to 10 per hour, and sessions last 8 hours.

Public surface: GET /, /admin (page shell only), /app.js, /admin.js, /ui.js, /fees.js, /styles.css, /favicon.svg, /api/engineers (public profiles only: no email or payment details), /api/pricing; POST /api/engineers, /api/login, /api/logout, /api/jobs, /api/admin/login, /api/admin/logout. Everything else needs a signed-in engineer, client or staff member with the right role. `test/api.test.js` fails if this list changes.

## Tests

`npm test` runs unit, API, browser and scale tests (Playwright Chromium must be installed). The scale test loads 5,000 engineers and times the list, search and paging against fixed limits. `SHOTS=<folder>` saves screenshots.

## License

[PolyForm Shield 1.0.0](LICENSE): you may read, run and change this code, but not use it to offer a service that competes with CodeMarcer. It is source-available, not open source.

Required Notice: Copyright (c) 2026 William Tai
