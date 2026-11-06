# Working on CodeMarcer

## Get it running (about 2 minutes)

1. Install Go 1.24 or newer, and Node 20 or newer (Node is only for the browser tests).
2. `npm ci` (installs the pinned Playwright; the server itself has no third-party dependencies).
3. `npx playwright install chromium`
4. `npm test` — builds `bin/codemarcer`, runs the Go tests, then the API, browser and scale tests. All should pass before you change anything.
5. `DATA_DIR=./data bin/codemarcer admin` to create a local owner login, then `DATA_DIR=./data bin/codemarcer` and open http://127.0.0.1:8080 and /admin.

## Where things are

- `main.go` — HTTP, security headers, sessions, rate limits, the built-in pages, the `admin` command.
- `api.go` — every API route with its role check.
- `rules.go` — validation of every request field, quotes, job status rules, staff permissions.
- `store.go` — records and JSON file storage with atomic writes.
- `auth.go` — password hashing and the owner account.
- `fees.go` and `public/fees.js` — fee rules for the server and the page (a test keeps them equal).
- `public/` — the site and admin page (plain ES modules, no build step), built into the binary.
- `logic_test.go` — Go unit tests. `test/` — API, browser and scale tests that drive the real binary.

## Rules for changes

- Work on a branch and open a pull request into `main`. Don't push to `main`.
- CI must be green (gofmt, go vet, govulncheck, tests and the secret scan) before merge.
- Keep the server on Go's standard library. A third-party module needs a written reason in the PR.
- When a check fails, CI reports it by itself: a comment on the pull request, or an issue labelled `failure` for `main`, naming the step that failed and the raw output.
- Every bug fix or feature comes with a test that would have caught it.
- Any route reachable without signing in must be added to the public list in `test/api.test.js` on purpose.
- Never loosen a security header, cookie setting or rate limit without saying so in the PR: what changed, what it protected against, and why it's acceptable.
- No outside requests from the pages (fonts, CDNs, analytics); the browser tests fail if one appears.
- Never commit `data/`, `.env`, passwords or keys.

## Paid work, not volunteer work

Work on this codebase is hired through the site. List yourself at https://codemarcer.com/#engineers with your rate and packages; when there's work, you'll get a request like any other client's. Please don't send unsolicited pull requests.

Bug reports are welcome as issues. Security problems: report privately, see SECURITY.md.

Code you're paid to write for this repository is covered by the license in LICENSE (PolyForm Shield 1.0.0).
