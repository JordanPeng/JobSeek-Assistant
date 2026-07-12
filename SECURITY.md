# Security Policy

JobSeek Assistant includes a Windows native-messaging host with access to the
current user's local JobSeek data. Install only code and release artifacts from
this repository, and review scripts before running them.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a
public issue containing credentials, resumes, application data, exploit details,
or other sensitive information.

Include:

- affected version or commit;
- reproduction steps using fake data;
- expected and observed behavior;
- security impact;
- any suggested mitigation.

## Supported versions

Security fixes target the latest release and the default branch.

## Security boundaries

The project intentionally does not submit applications, enter credentials,
solve CAPTCHAs, complete assessments, or accept attestations. Reports showing a
way around those boundaries are treated as security issues.

## Build dependency overrides

The root `package.json` pins audited transitive versions used only by WXT's
development toolchain. Keep `package-lock.json` committed and use `npm ci`.
Changes to these overrides require a clean build, full tests, and `npm audit`.
