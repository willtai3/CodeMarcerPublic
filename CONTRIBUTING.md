# Working on CodeMarcer

## Get it running (about 2 minutes)

1. Install Node 20 or newer.
2. `npm install` (installs Playwright for the browser tests; the app itself has no dependencies).
3. `npx playwright install chromium`
4. `npm test` — all tests should pass before you change anything.
5. `npm run admin` to create a local admin login, then `npm start` and open http://127.0.0.1:8080 and /admin.

## Where things are

- `server.js` — HTTP, security headers, sessions, rate limits.
- `lib/api.js` — every API route as a plain function (shared with the demo).
- `lib/rules.js` — validation, quotes, job status rules, public profile view.
- `lib/auth.js`, `admin-setup.js` — scrypt passwords and the owner account.
- `lib/store.js` — JSON file storage with atomic writes.
- `public/fees.js` — the only place fee rules live (free before Feb 1, 2027 Pacific, then 10% of completed jobs).
- `public/` — the site and admin page (plain ES modules, no build step).
- `test/` — unit, API and Playwright browser tests.

## Rules for changes

- Work on a branch and open a pull request into `main`. Don't push to `main`.
- CI must be green (tests and the secret scan) before merge.
- Every bug fix or feature comes with a test that would have caught it.
- Any route reachable without signing in must be added to the public list in `test/api.test.js` on purpose.
- Never loosen a security header, cookie setting or rate limit without saying so in the PR: what changed, what it protected against, and why it's acceptable.
- No outside requests from the pages (fonts, CDNs, analytics); the browser tests fail if one appears.
- Never commit `data/`, `.env`, passwords or keys.

## Paid work, not volunteer work

Work on this codebase is hired through the site. List yourself at https://codemarcer.com/#engineers with your rate and packages; when there's work, you'll get a request like any other client's. Please don't send unsolicited pull requests.

Bug reports are welcome as issues. Security problems: report privately, see SECURITY.md.

Code you're paid to write for this repository is covered by the license in LICENSE (PolyForm Shield 1.0.0).
