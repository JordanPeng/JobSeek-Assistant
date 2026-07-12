# Backup, Restore, and Local Data Deletion

JobSeek Assistant keeps all data locally under
`%LOCALAPPDATA%\JobSeekAssistant\`. Phase 9 adds password-encrypted backups with a
preview-before-import flow and separate, category-scoped deletion controls. This document
describes the on-disk backup format, what is and is not included, and the privacy
guarantees of both features.

## Where backups live

- Backups are written **only** to `%LOCALAPPDATA%\JobSeekAssistant\exports\` with a
  generated name of the form `jobseek-backup-<yyyyMMdd-HHmmss>-<id8>.jsabackup`.
- The companion never accepts a caller-supplied output path for export. For preview and
  apply, the supplied path is resolved and rejected unless it is a `.jsabackup` file
  located directly in the exports folder. This blocks path traversal and arbitrary
  filesystem reads.
- `backup.list` enumerates only the exports folder and returns each file's name, size, and
  creation time (plus the absolute path for same-machine restore). It never enumerates
  arbitrary directories.

## Encrypted file format (`.jsabackup`)

Each file is a self-describing, authenticated container produced by built-in .NET
cryptography (no third-party crypto):

| Field | Notes |
| --- | --- |
| Magic | `JSAB` (4 bytes), fixed |
| Format version | 1 byte, currently `1` |
| KDF id | 1 byte, `1` = PBKDF2-SHA256 |
| Compression id | 1 byte, `1` = GZip |
| Iterations | uint32, **>= 300,000** |
| Salt | length-prefixed, random, **>= 16 bytes** |
| Nonce | length-prefixed, random 12-byte AES-GCM nonce |
| Ciphertext | AES-256-GCM over the GZip-compressed archive |
| Tag | 16-byte AES-GCM authentication tag |

- The symmetric key is derived from the user password with **PBKDF2-SHA256** using the
  random per-file salt and iteration count.
- The archive is sealed with **AES-256-GCM**. The header (magic, version, KDF parameters,
  salt, nonce) is bound as GCM associated data, so tampering with any header field fails
  authentication.
- The **password is never stored, logged, or audited**. It exists only in memory for the
  duration of a single request. Wrong password and tampering are both reported as a
  `bad_password` error; malformed magic/version report `bad_magic`/`bad_version`.
- **Maximum backup size is 50 MiB**, enforced on both export and import. No plaintext
  temporary file is ever written; the archive is built and encrypted in memory.

## What a backup contains

The plaintext archive is a strict, versioned schema (`schemaVersion` 1). Sensitive database
columns are stored **already decrypted** inside the archive - the container's own AES-GCM
layer protects them at rest - and are re-encrypted with the current user's DPAPI key on
restore.

Included:

- Profile versions and facts (restores version history)
- Answer bank and answer version history
- Applications, application events, redacted email evidence, and status proposals
- Diagnostics and the activity/audit trail
- Copilot enabled state and preferred model
- Document metadata **and** decrypted bytes **only when `includeDocuments` is true**
  (default is off). Document bytes are decrypted from the DPAPI vault in memory, verified
  against their SHA-256, and placed inside the encrypted archive.

**Never** included (these are excluded by construction and verified by tests):

- Google OAuth **client** secret / configuration
- Gmail access/refresh tokens or the DPAPI token store
- Gmail history cursor / sync state
- GitHub / Copilot credentials
- Browser storage, profile, or cookies
- Companion logs, queue state, or environment keys

## Preview before import

`backup.import.preview` decrypts and fully validates a file **without mutating the database
or vault**. It checks magic, version, AES-GCM authentication, the strict schema, identifier
uniqueness, enum values, cross-entity references, per-document SHA-256 integrity, and PDF
limits. It returns the backup id, export time, schema version, `includesDocuments`,
per-entity counts, and replacement warnings. It stores no password or plaintext beyond the
call.

## Apply (full replace)

`backup.import.apply` re-decrypts and re-validates the file and requires the caller to pass
the `expectedBackupId` from the preview, preventing a time-of-check/time-of-use swap.
Restore is an explicit **full replace** of the backed-up categories, not a silent merge:

- All work happens in a single database transaction with staged, DPAPI-re-encrypted vault
  files and compensating cleanup, so a failure leaves the database and vault unchanged and
  never leaves orphaned files.
- Sensitive values and document bytes are **re-encrypted with the current user's DPAPI
  key** - the old DPAPI ciphertext is never copied.
- `schema_version`, install configuration, and the on-disk OAuth token store binaries are
  preserved, but the **Gmail connection is reset to disconnected** and tokens/cursors are
  **not** restored. Reconnect Gmail after a restore.
- Copilot enabled state and preferred model are restored from the archive.
- A single count-only restore summary is written to the audit trail; it embeds no private
  data.

## Separate deletion controls (`data.delete`)

Deletion is category-scoped and each category requires its **exact** confirmation phrase.
Deletions run in a single transaction, remove rows in foreign-key-safe order, and (except
for `activity` and `all`) record a count-only audit summary. Every request returns the
counts deleted; there is no silent no-op.

| Category | Removes | Confirmation phrase |
| --- | --- | --- |
| `profile` | All profile versions and facts | `DELETE PROFILE` |
| `answers` | Answers and answer versions | `DELETE ANSWERS` |
| `documents` | Document metadata and vault files | `DELETE DOCUMENTS` |
| `applications` | Proposals, events, evidence, applications (FK-safe) | `DELETE APPLICATIONS` |
| `gmail_evidence` | Email evidence, proposals, and sync cursor (keeps the token) | `DELETE GMAIL EVIDENCE` |
| `diagnostics` | Redacted diagnostics | `DELETE DIAGNOSTICS` |
| `activity` | The activity/undo history | `DELETE ACTIVITY` |
| `all` | Everything above, plus the Gmail token and Copilot settings (reset to disabled) | `DELETE ALL LOCAL DATA` |

Deleting Gmail evidence does **not** delete the OAuth token; only a full wipe (`all`)
clears the token. A full wipe preserves the Google OAuth **client** configuration and the
installed binaries. Vault files and the Gmail token are removed only after the database
transaction commits, so a failure leaves everything consistent.

## Options UI

The **Settings** tab exposes:

- **Encrypted backup** - a password + confirmation, an "include documents" toggle
  (default off), an Export button, a list of backup files, and a restore flow that
  requires a preview and typing `RESTORE BACKUP` before Apply is enabled.
- **Delete local data** - one button per category with a description, an inline typed
  confirmation (no `window.confirm`), and a counts result. The UI notes that disconnecting
  Gmail and deleting its token is separate except for a full wipe.

The UI states that exports are password-encrypted and that Gmail and GitHub/Copilot tokens
are never included.
