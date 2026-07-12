# JobSeek Assistant

[![CI](https://github.com/JordanPeng/JobSeek-Assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/JordanPeng/JobSeek-Assistant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local-only Microsoft Edge extension plus a Windows companion that helps you
**review and fill** job-application forms and **track** your applications. It is
deliberately conservative: it fills fields you can see and review, and it never
submits, navigates, logs in, or completes anything on your behalf.

By default, all data stays on your machine. There is no JobSeek backend, cloud
sync, telemetry, or analytics. Optional Gmail and Copilot features contact
Google or GitHub only after separate configuration and explicit consent.

> [!WARNING]
> This project installs a Windows native-messaging host and per-user registry
> entries. Build from source or use only release artifacts from this repository.
> Never commit your resume, OAuth client, tokens, database, vault, or browser
> profile.

## Product goal

- Extract your profile facts once (from a reviewed local resume import) and reuse
  them to fill application forms after you inspect the proposed values.
- Keep a private, immutable-history application tracker.
- Optionally reconcile ambiguous Gmail messages (read-only) into *pending*
  status proposals that you confirm.

## Hard boundaries (what it will never do)

The assistant will **never**:

- Submit an application or click Submit/Next/Apply/Finish.
- Advance application steps or change a queued page after opening the exact
  user-reviewed URL.
- Log in, enter credentials, or handle SSO on your behalf.
- Solve or bypass a CAPTCHA.
- Complete an assessment, coding test, or timed exercise.
- Attest, sign, agree to, or check legal/authorization/EEO attestations for you.

These actions are structurally absent from the code paths, not merely disabled
by a setting. Autofill targets form fields only, after you inspect them.

## Architecture (short)

```
Edge extension (MV3)  ──native messaging──►  NativeHost.exe  ──named pipe──►  Agent.exe
   content/UI, no                              stdio bridge,                   SQLite + DPAPI vault,
   remote code                                 current user only               tracker, Gmail (read-only),
                                                                                optional zero-tool worker
```

- The **extension** runs in Edge, holds no secrets, and requests no required
  host permissions. Broad HTTPS access is optional and granted per-domain by
  you.
- The **native host** is a thin stdio ↔ named-pipe forwarder that only accepts
  the current Windows user.
- The **agent** is a background process (scheduled task, per-session) that owns
  the SQLite database, the DPAPI-encrypted document vault, the tracker, the
  Gmail read-only client, and an optional Copilot worker.

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Prerequisites

- Windows 10/11, signed in as the user who will use the assistant.
- Microsoft Edge (Stable).
- PowerShell 7+, .NET 10 SDK, Node.js 24+ / npm 11+, Git.
- (Optional, AI answers) GitHub Copilot access and an authenticated Copilot
  runtime supported by `@github/copilot-sdk`.
- (Optional, Gmail) a Google **Desktop app** OAuth client saved as
  `client_secret_*.json` in this project folder. It is git-ignored and never
  packaged.

Verify readiness without changing anything:

```powershell
pwsh -File scripts/check-windows.ps1
```

## Build and install

Clone the repository, then run the commands from its root:

```powershell
git clone https://github.com/JordanPeng/JobSeek-Assistant.git
cd JobSeek-Assistant

# 1. Install workspace dependencies
npm ci

# 2. Build the production Edge extension (unpacked, MV3)
npm run build --workspace @jobseek/extension
#    Output: apps/extension/.output/edge-mv3

# 3. Build, validate, and atomically install the companion bridge
pwsh -File scripts/install-windows.ps1
```

`install-windows.ps1` builds everything into a unique staging directory, checks
the artifacts, and only then swaps the live install in one move, refreshes the
native manifest / registry / scheduled task, starts the agent, and health-checks
it. It is safe to re-run at any time, including while the agent is running, and
rolls back to the previous install if the new one is unhealthy. Your data,
vault, database, exports, and OAuth client/token are never touched by an update.

### Load the unpacked extension in Edge

1. Open `edge://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `apps/extension/.output/edge-mv3`.
3. The extension uses a fixed public key, so it always gets the stable id
   **`eblebceopnkaakmhgdcdbpdaampoildh`**. The installer registers exactly that
   id with the native host, so no per-machine id editing is needed.

Stable output path: `apps/extension/.output/edge-mv3`
Stable extension id: `eblebceopnkaakmhgdcdbpdaampoildh`

## Using it

### Onboarding, profile, and resume

- On first run, import your local resume once and **review every extracted
  fact** before saving. Resume import is explicit; nothing is read automatically.
- Attaching your resume/CV as a file to an application is a separate explicit
  opt-in (off by default).

### Explicit fill

- Open a job form, open the assistant, and **Inspect** the page. It proposes
  values for the fields it recognizes.
- Existing values are preserved by default; sensitive and unknown answers require
  your confirmation.
- **Fill** applies the reviewed values; **Undo** reverts the last fill. Nothing
  is submitted.

### Optional safe preparation queue

- You may queue domains to *prepare* (open and inspect) ahead of time. Each
  domain requires you to grant the optional **HTTPS host permission for that
  domain** first; there are no required host permissions and no broad grant.
- Preparation is off by default and never submits anything.

### Application tracker

- Applications, events, and statuses are recorded locally with immutable history
  and undo. Filling a form never sets a status to "applied" by itself.

### Gmail (optional, read-only)

- If configured with a Desktop OAuth client, the agent can poll Gmail
  **read-only**, minimize evidence to short snippets, and create **pending**
  status proposals you confirm. Confirmation-before-update is the default.
- Gmail is disconnected after a data restore and must be reconnected. See the
  weekly-reconnect caveat in [`docs/testing.md`](docs/testing.md).

### Optional Copilot email classifier

- An optional, separately installed **zero-tool** worker can help classify
  ambiguous emails. It is **disabled by default**, exposes no filesystem,
  shell, browser, MCP, database, or Gmail tools to the model, and can only
  return a suggestion the agent independently validates into a pending
  proposal.

### Optional grounded application answers

- With separate explicit consent, the zero-tool Copilot worker can receive your
  full reviewed profile, extracted active-resume text, and eligible ordinary
  application questions/options. It prefers **GPT-5.6 Luna** with high
  reasoning when available.
- It never receives the answer bank, Gmail data, application notes, browser
  values, legal/EEO/salary/work-authorization questions, or attestations.
- Supported option answers may be saved for the same company. Generated
  narratives fill the current page but are saved as **AI drafts** until you
  confirm them once. Unsupported questions remain blank.

## Backup, restore, and deletion

- Password-encrypted backups (AES-256-GCM) are written only to
  `%LOCALAPPDATA%\JobSeekAssistant\exports\`. Documents are included only if you
  explicitly opt in. Imports **preview** schema/version/change counts before any
  mutation.
- Deletion is category-scoped and each category requires an exact typed
  confirmation phrase.
- Details: [`docs/BACKUP_AND_PRIVACY.md`](docs/BACKUP_AND_PRIVACY.md) and
  [`docs/privacy.md`](docs/privacy.md).

## Uninstall

```powershell
# Remove binaries + registration, preserve all data (default):
pwsh -File scripts/uninstall-windows.ps1

# Also delete ALL local data (requires the exact phrase):
pwsh -File scripts/uninstall-windows.ps1 -DeleteData -Confirmation 'DELETE ALL LOCAL DATA'
```

A bare `-DeleteData` switch never wipes data on its own.

## Commands

| Command | Purpose |
| --- | --- |
| `pwsh -File scripts/check-windows.ps1` | Report readiness/versions (no changes). |
| `pwsh -File scripts/install-windows.ps1` | Atomic build + install/update. |
| `pwsh -File scripts/status-windows.ps1` | Report install/health/task/OAuth type. |
| `pwsh -File scripts/uninstall-windows.ps1` | Remove; preserves data by default. |
| `npm run audit:artifacts` | Fail on secrets/PII/maps/tests/remote code/manifest drift. |
| `npm run check:release` | Non-mutating release gate (manifest + privacy + audit). |
| `npm test` / `npm run test:e2e` | Unit tests / Playwright extension tests. |
| `pwsh -File scripts/tests/Invoke-ScriptTests.ps1` | Parser + helper unit tests for the scripts. |

## Limitations (realistic)

- It fills forms you can see; it does not complete applications.
- ATS coverage is best-effort and adapter-specific (see
  [`docs/compatibility.md`](docs/compatibility.md)). Cross-origin frames, closed
  shadow DOM, CAPTCHA, auth walls, and assessments are unsupported.
- Manual Microsoft Edge Stable acceptance and Gmail consent are not claimed as
  complete until recorded in the docs; automated Chromium/Playwright results are
  synthetic-fixture only.

## License and privacy

JobSeek Assistant is available under the [MIT License](LICENSE).

This public repository contains no resume, OAuth client, credential, token,
database, browser profile, or runtime state. Each user supplies and reviews
their own local data. The project is not affiliated with Microsoft, GitHub,
Google, any employer, or any ATS provider.
