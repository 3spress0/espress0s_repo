# Contributing to espress0

Thanks for taking the time. This is a personal, all-rights-reserved project
(see `LICENSE`), so contributions are accepted at the maintainer's discretion
and there is no CLA: by opening a pull request you agree that your change may
be included under the repository's existing terms.

Please read this page before opening an issue or a PR - it is short.

## Ground rules

- **One thing per pull request.** A PR fixes one bug or adds one feature.
  Unrelated clean-ups belong in their own PR.
- **Do not duplicate what exists.** Before building, check
  `backend/src/routes`, `backend/src/services`, `frontend/src/pages` and
  `frontend/src/components`. Extend the existing module rather than adding a
  parallel one.
- **Keep the architecture.** Fastify + better-sqlite3 (FTS5) on the backend,
  React + Vite + Tailwind on the frontend, no extra services or heavy
  dependencies without prior discussion in an issue.
- **Security first.** This app stores encrypted links and handles uploads
  and outbound fetches. Read `SECURITY-AUDIT.md`; keep URL validation
  (`backend/src/utils/validation.js`), SSRF guards (`lib/safeFetch.js`) and
  the role gates (`middleware/auth.js`) intact. Report vulnerabilities
  privately, not in a public issue.
- **Tests and lint must be green.** `./espress0 test` runs everything CI
  runs; both `npm run lint` scripts must report zero errors.

## Development setup

```bash
git clone <your fork> && cd espress0s_repo
./espress0 setup          # first time: env, deps, database
./espress0 dev            # backend + frontend with hot reload
```

If `npm install` in `backend/` fails compiling `better-sqlite3`, point
node-gyp at your Node headers, e.g. `npm_config_nodedir=/usr/local npm install`.

Useful commands:

| Command | What it does |
| --- | --- |
| `./espress0 test` | backend tests, frontend tests, shell tests (same as CI) |
| `cd backend && npm test` | backend only (`node --test` with `tests/setup.mjs` isolation) |
| `cd backend && node --import ./tests/setup.mjs --test tests/foo.test.js` | one backend test file |
| `cd backend && npm run lint` / `cd frontend && npm run lint` | ESLint (0 errors required; warnings are tolerated) |
| `cd frontend && npx vite build` | production build check |
| `./espress0 scan` | security scan (audit + secret patterns) |

The backend test setup opens a throw-away database and neutral env; never
point tests at a real `.env` or `data/repo.db`.

## Making a change

1. Open an issue first for anything bigger than a small fix, so the approach
   can be agreed before code is written.
2. Branch from `main`. Name it `fix/<topic>` or `feat/<topic>`.
3. Write the code **and** the test. Backend features get a
   `backend/tests/<feature>.test.js`; follow an existing file (e.g.
   `favorites.test.js`, `reviews.test.js`) for the Fastify + inject pattern.
4. Update docs that describe the behaviour you touched: `README.md` has a
   section per feature; `CATALOG.md` covers the import/export formats;
   `SETUP.md` covers deployment.
5. Run `./espress0 test` and both lints.
6. Commit with a clear message (see below) and open a PR using the template.

### Commit messages

Conventional-commit style, imperative mood, scope optional:

```
feat(reviews): hold comments with links for moderation
fix(import): keep single-digit tokens in duplicate detector
docs: describe torrent mirrors in CATALOG.md
```

Reference the issue in the body (`Closes #12`).

### Database changes

- Add new tables/columns to `backend/src/db/schema.js` **and** an idempotent
  migration in `backend/src/db/index.js` for databases that already exist
  (`PRAGMA table_info` check, then `ALTER TABLE`).
- SQLite cannot alter a `CHECK` constraint; if you must widen one, rebuild
  the table in a transaction and recreate its indexes (see the
  `item_download_links` torrent migration for the pattern).
- Never store plaintext URLs/paths in encrypted columns; go through
  `encryptionService`.

### Frontend notes

- Pages are lazy-loaded from `App.jsx`; add new admin pages to the route
  list **and** the nav in `pages/Admin.jsx` (mark `editor: true` if editors
  may use it).
- Use the existing `lib/api.js` client; add one `xxxApi` object per backend
  route group.
- Anything rendered as an `href` must pass `safeHref()` in `lib/utils.js`.
- New user-facing strings should go through the i18n helper where the page
  already uses it (`useI18n`).

### Backend notes

- Routes live in `backend/src/routes`, business logic in
  `backend/src/services`. Routes validate with zod schemas from
  `utils/validation.js` and return plain objects.
- Admin routes are admin-only by default; add a route to `EDITOR_ROUTES` in
  `routes/admin.js` only when editors genuinely need it.
- Emit domain events through `services/eventBus.js` so webhooks and
  subscriptions pick them up; document new event types in its header
  comment and in the README webhooks table.
- Public endpoints get their own rate-limit config (`config: { rateLimit }`
  on the route).

## Reporting bugs and requesting features

Use the issue templates. For bugs include the exact steps, expected vs
actual result, the `./espress0 status` output and relevant log lines (with
secrets removed). For features explain the problem before the solution.

## Code of conduct

Be kind and specific. Critique code, not people. Maintainer decisions on
scope are final; forks are welcome within the licence terms.
