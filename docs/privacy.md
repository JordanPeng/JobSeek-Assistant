# Privacy

JobSeek Assistant is local-only by design. There is **no backend, no cloud sync,
no telemetry, and no analytics**. Nothing about your profile, applications, or
email is transmitted to any JobSeek-operated service, because none exists.

## Where data lives

All data is under `%LOCALAPPDATA%\JobSeekAssistant\`:

| Path | Contents | Encryption |
| --- | --- | --- |
| `data\jobseek.db` (+ `-wal`, `-shm`) | Profile, answers, applications, events, redacted email evidence, proposals, diagnostics, activity/audit trail, Copilot settings | Sensitive columns encrypted with DPAPI (CurrentUser) |
| `vault\` | Document (resume/CV) bytes | DPAPI (CurrentUser), verified by SHA-256 |
| `config\google-oauth-client.json` | Google **Desktop** OAuth client config | Current-user ACL (icacls) |
| `config\gmail-token\` | Gmail token store | DPAPI (CurrentUser) |
| `exports\*.jsabackup` | Encrypted backups | AES-256-GCM over PBKDF2-SHA256 key |
| `logs\` | Operational logs | Redacted; no secrets or PII contents |

The extension keeps only local settings and non-sensitive UI state in Edge
extension storage.

## Encryption

- **At rest** — sensitive database columns and vaulted document bytes are sealed
  with the current Windows user's DPAPI key, so only that user (on that machine)
  can read them.
- **Backups** — each `.jsabackup` is an authenticated AES-256-GCM container whose
  key is derived from your password via PBKDF2-SHA256 (≥ 300,000 iterations,
  random salt). The header is bound as GCM associated data. The password is never
  stored, logged, or audited.
- **Restore** — values are re-encrypted with the current user's DPAPI key; old
  DPAPI ciphertext is never copied.

## No telemetry or project backend

- The extension requests **no required host permissions** and makes no
  extension-originated network requests. Broad HTTPS access is optional and
  granted by you per-domain.
- The companion runs no HTTP server and opens no outbound analytics connections.
- The only outbound network paths are the **optional** Gmail read-only API
  (Google) and explicit GitHub Copilot features. There is no project backend,
  telemetry, analytics, or cloud synchronization.

### Explicit grounded-answer cloud consent

When grounded application answers are enabled, the user explicitly authorizes
sending the latest full reviewed profile, extracted active-resume text, and
eligible ordinary page questions/options to GitHub Copilot. The companion
blocks salary, relocation, EEO/demographic, disability, veteran, legal,
conflict/non-compete, export/citizenship, work-authorization/sponsorship,
consent/signature, and assessment questions before any model call.

The cloud payload excludes the answer bank, Gmail content/IDs/tokens,
application notes, browser-entered values, database paths, and environment
secrets. Generated narratives are stored as encrypted unconfirmed drafts;
verified selection answers may be reused only under conservative company/domain
scope.

## Gmail snippet minimization

When Gmail is enabled, the agent polls **read-only** and stores only the minimum
evidence needed to propose a status change: short subject/snippet fragments,
sender domain, and timestamp. Full message bodies are not retained. Ambiguous
messages become **pending** proposals you confirm; nothing changes automatically.

## Browserbase / Exa are not integrated for real data

References to Browserbase and Exa exist only as isolation guards: the optional
Copilot worker is launched with those (and GitHub/Google) secret environment
variables explicitly stripped, and the release audit fails if their values appear
in any artifact. **No Browserbase or Exa integration processes your real data.**

## Backup exclusions

Backups **never** include:

- The Google OAuth **client** secret/config
- Gmail access/refresh tokens or the DPAPI token store
- Gmail history cursor / sync state
- GitHub / Copilot credentials
- Browser storage, profile, or cookies
- Companion logs, queue state, or environment keys

Document bytes are included only when you explicitly opt in
(`includeDocuments`, default off).

## Deletion

Deletion is category-scoped; each category requires an exact typed confirmation
phrase (e.g. `DELETE PROFILE`, `DELETE APPLICATIONS`, `DELETE ALL LOCAL DATA`).
Deletions run in a single transaction and report the counts removed. Deleting
Gmail evidence does not delete the OAuth token; only a full wipe clears the
token. A full wipe still preserves the OAuth **client** configuration and the
installed binaries. See [`BACKUP_AND_PRIVACY.md`](BACKUP_AND_PRIVACY.md) for the
full table and file format.

## Release guarantees

`scripts/audit-artifacts.ps1` (run via `npm run audit:artifacts` or
`npm run check:release`) fails the build if any extension, worker, or companion
artifact contains OAuth/client secrets, databases, vault/token/browser-profile
data, resume source/PDF, source maps, tests, remote code, telemetry domains, or a
manifest that deviates from the exact production policy. Sensitive-string needles
are derived at runtime from the local OAuth client and tracked resume; the audit
reports only offending artifact paths and codes, never the secret values.
