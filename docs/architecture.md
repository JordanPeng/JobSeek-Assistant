# Architecture

JobSeek Assistant is three cooperating processes plus an optional worker. Every
component runs as the signed-in Windows user, on the local machine only.

## Processes and trust boundaries

```
┌──────────────────────────────┐
│ Microsoft Edge (MV3 extension)│  no secrets, no required host permissions,
│  - background service worker  │  no remote code (CSP: script-src 'self')
│  - options / popup UI (React) │
│  - page runtime (autofill)    │
└───────────────┬──────────────┘
                │ chrome.runtime native messaging (stdio, JSON)
                ▼
┌──────────────────────────────┐
│ JobSeek.NativeHost.exe        │  thin stdio ↔ named-pipe forwarder;
│  - length-prefixed JSON       │  launches/relays to the agent
└───────────────┬──────────────┘
                │ named pipe: JobSeekAssistant.<user SID>  (current user ACL only)
                ▼
┌──────────────────────────────┐
│ JobSeek.Agent.exe             │  owns all local state; runs as an at-logon
│  - SQLite (WAL) + migrations  │  scheduled task, Interactive + Limited
│  - DPAPI document vault       │  (never elevated)
│  - application tracker        │
│  - Gmail read-only client     │
│  - backup / deletion services │
└───────────────┬──────────────┘
                │ optional, on-demand, one bounded request/response over stdio
                ▼
┌──────────────────────────────┐
│ Copilot worker (Node, zero-tool)│  disabled by default; no fs/shell/browser/
│  - email classification         │  MCP/db/Gmail/custom tools; env stripped
│  - grounded app answers         │
└──────────────────────────────┘
```

The trust boundaries are:

1. **Web page ↔ extension** — content/page-runtime code reads and fills DOM
   fields only; it holds no credentials and issues no extension-originated
   network requests.
2. **Extension ↔ native host** — Edge native messaging (stdio). Messages are
   validated JSON against the shared `contracts/v1` schema.
3. **Native host ↔ agent** — a per-user named pipe whose name embeds the user
   SID and whose ACL admits only the current user. Malformed or oversized
   messages are rejected.
4. **Agent ↔ Copilot worker** — a single bounded JSON request/response over
   stdio to a process launched with a cleared environment.

## Data flow

1. **Onboarding** — you explicitly import a local resume. The agent extracts
   facts; you review each one; approved facts are stored as versioned profile
   data.
2. **Inspect** — the extension builds field descriptors for the current page,
   selects an adapter (generic or ATS-specific), and asks the agent to match
   descriptors to profile/answer-bank values with confidence and sensitivity
   scoring.
3. **Fill / Undo** — after your review, the extension writes values and verifies
   read-back; Undo reverts the last fill. No navigation or submission occurs.
4. **Track** — application records, events, and status changes are stored with
   immutable history and undo.
5. **Gmail (optional)** — the agent polls read-only, minimizes evidence, and
   writes *pending* proposals; you confirm before any status changes.
6. **Grounded application answers (optional)** — after page inspection, the
   agent asynchronously supplies the consented reviewed profile/resume and only
   eligible ordinary unresolved questions to the zero-tool worker. Validated
   answers fill a freshly re-inspected page; unsupported questions stay blank.

## Protocol

- The wire protocol is a length-prefixed (4-byte little-endian) UTF-8 JSON
  envelope: `{ protocolVersion, requestId, operation, payload }` with a matching
  `{ protocolVersion, requestId, ok, result | error }` response.
- Schemas are shared: TypeScript Zod schemas on the extension side and matching
  C# records/validators on the companion side, both exercised by the
  `contracts/v1` fixtures.
- Operations include `health.get`, profile/answer/application CRUD,
  `gmail.*`, `copilot.*`, `backup.*`, and `data.delete`. Unknown operations and
  extra fields are rejected.

## Current-user pipe and DPAPI

- **Named pipe** — `JobSeekAssistant.<SID with '-' → '_'>`. The SID scoping plus
  a current-user ACL means another user on the same machine cannot connect.
- **DPAPI** — sensitive database columns and vaulted document bytes are encrypted
  with the current Windows user's DPAPI key (`CurrentUser` scope). Backups carry
  their own AES-256-GCM layer and are re-encrypted to the current user's DPAPI
  key on restore; old DPAPI ciphertext is never copied.

## Zero-tool worker

The optional Copilot worker classifies ambiguous emails and generates
explicitly consented, source-grounded ordinary application answers. It:

- accepts exactly one bounded request on stdin and emits one bounded response on
  stdout;
- has **no** filesystem, shell, browser, MCP, database, Gmail, or custom tools,
  and rejects every permission request;
- is launched by the agent with a cleared environment (only a small allow-list of
  process variables; known secret variables are explicitly removed);
- **cannot** update an application or database directly — the agent validates
  every output. Email results become pending proposals. Application narratives
  become encrypted drafts; exact supplied-option answers use conservative
  reusable scope.

## Install layout

Runtime lives under `%LOCALAPPDATA%\JobSeekAssistant\`:

| Path | Contents |
| --- | --- |
| `app\agent\` | Published `JobSeek.Agent.exe` and dependencies |
| `app\nativehost\` | Published `JobSeek.NativeHost.exe` |
| `app\copilot-worker\` | Worker `dist\` + production `node_modules` |
| `config\` | Pointers, native manifest, OAuth client, Gmail token store |
| `data\` | SQLite database (`jobseek.db`) |
| `vault\` | DPAPI-encrypted document bytes |
| `exports\` | Encrypted `.jsabackup` files |
| `logs\` | Redacted operational logs |

Updates only ever replace `app\`; everything else is preserved. The native
messaging host is registered under
`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.jobseek.assistant`, and the
agent runs from the `JobSeek Assistant Agent` at-logon scheduled task.
