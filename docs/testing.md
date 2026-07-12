# Testing

All tests use **original, fake data and synthetic fixtures**. No real employer
site source, no real applications, and no real personal data are used in any
automated test.

## Commands

TypeScript / extension:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test                 # vitest unit tests (engine, adapters, native protocol, data)
```

Companion (.NET):

```powershell
dotnet format .\companion\JobSeek.sln --verify-no-changes
dotnet test .\companion\JobSeek.sln
```

End-to-end (Playwright Chromium, unpacked MV3):

```powershell
npm run test:e2e         # builds the e2e extension, serves fake ATS fixtures, runs Playwright
```

Windows scripts:

```powershell
pwsh -File scripts/tests/Invoke-ScriptTests.ps1   # parser checks + helper unit tests
```

## Fake-data policy

- Fixtures are original and contain only invented data.
- Fixtures include native controls, React-controlled inputs, custom comboboxes,
  dynamic employment/education sections, open shadow DOM, a same-origin iframe, a
  cross-origin placeholder, decoy search/login/payment fields, resume upload, a
  CAPTCHA marker, and legal/EEO/disability/veteran/authorization questions.
- Submit/Next controls in fixtures are instrumented to **fail the test if
  activated**. The suite asserts zero submit/Next/CAPTCHA/auth/assessment
  interaction and no unexpected extension-originated network requests.
- The e2e suite uses no employer site, user profile, Gmail, Browserbase, Exa, or
  native companion. Its options-page check intentionally verifies the dashboard
  when the companion is unavailable.

## e2e scope caveats

- The production page runtime targets the **top document only**, so the
  same-origin-frame fixture is covered by the engine but is **not** a production
  autofill path. The sandboxed cross-origin placeholder is deliberately
  inaccessible; `frame.cross_origin` can only be emitted when a caller supplies
  frame metadata, which the page runtime does not discover — a reported
  production-scope gap, not an e2e claim.

## Production manifest and artifact checks

Run the non-mutating release gate; it does not build, install, or change state:

```powershell
npm run build --workspace @jobseek/extension   # produce the production manifest first
npm run check:release
```

`check:release` verifies:

- The production Edge manifest exactly matches policy: permissions
  `activeTab, alarms, nativeMessaging, scripting, storage`; CSP
  `script-src 'self'; object-src 'self'`; **no required host permissions**;
  optional host permission `https://*/*` only (HTTPS); stable public key/id.
- Git privacy: no resume, PDF, OAuth client, token, database, vault, or
  browser-profile files are tracked; local OAuth client patterns are ignored.
- `audit:artifacts`: extension build, installed/staged Copilot worker, and
  companion Release publishes contain no secrets, PII, runtime state, source
  maps, tests, remote code, or telemetry. Only offending paths/codes are
  reported, never secret values. The public extension key is allowed.

Supply-chain checks (record any accepted exceptions):

```powershell
npm audit
dotnet list .\companion\JobSeek.sln package --vulnerable --include-transitive
```

## Manual Microsoft Edge Stable acceptance checklist

Automated Chromium tests are necessary but **not sufficient**. Before v1 is
called complete, run these once on Edge Stable and record results in
[`compatibility.md`](compatibility.md):

1. Load the unpacked extension in a dedicated Edge test profile.
2. Confirm the native host is registered for the stable id
   `eblebceopnkaakmhgdcdbpdaampoildh`.
3. Import the real local resume and review every extracted fact.
4. Test generic, Greenhouse, Lever, and at least one complex ATS fixture.
5. Restart Edge and the companion.
6. Verify encrypted data remains accessible only to the Windows user.
7. Verify no terminal submission action occurs.
8. Test Gmail consent/proposals if Gmail is enabled.
9. Record results (including any failures) in `compatibility.md`.

**Do not submit test applications to real employers.**

## Gmail read-only weekly reconnect caveat

While the Google OAuth app remains in **Testing** (unverified) status, Google
expires refresh tokens for read-only test users on a short cycle (about **7
days**). Expect to **re-run Gmail consent roughly weekly** during testing; a
`gmail.status` of disconnected after ~a week is expected, not a defect. This is a
Google testing-mode limitation, not a JobSeek bug, and does not affect autofill
or the tracker. Publishing/verifying the OAuth app would remove the weekly
reconnect, but that consent/verification is **not claimed as complete** here.
