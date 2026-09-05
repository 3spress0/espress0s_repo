## What

<!-- One sentence: what does this PR change? Link the issue: Closes #… -->

## Why

<!-- The problem this solves. If there was a design discussion, link it. -->

## How

<!-- Short walkthrough of the approach. Call out anything reviewers should look at closely. -->

## Checklist

- [ ] One feature / fix per PR; no unrelated changes
- [ ] I checked that this does not duplicate existing functionality
- [ ] Tests added or updated (`backend/tests/*.test.js` / frontend tests)
- [ ] `./espress0 test` passes locally
- [ ] `npm run lint` in `backend/` and `frontend/` reports 0 errors
- [ ] Docs updated (`README.md` / `CATALOG.md` / `SETUP.md`) where behaviour changed
- [ ] Database changes include an idempotent migration in `backend/src/db/index.js`
- [ ] No secrets, tokens or real data in the diff
- [ ] Security-relevant changes (auth, URLs, uploads, outbound fetch) are explained above

## Screenshots / output

<!-- UI changes: before/after. CLI/API changes: sample request/response. -->
