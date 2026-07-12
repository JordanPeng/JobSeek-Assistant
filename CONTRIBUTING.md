# Contributing

Contributions are welcome, especially reproducible ATS compatibility fixes and
privacy or safety improvements.

## Before opening a pull request

1. Use only fake data and synthetic fixtures.
2. Do not include employer page source, resumes, credentials, tokens, or real
   application content.
3. Preserve the no-submit, no-navigation, no-login, no-CAPTCHA, and
   no-attestation boundaries.
4. Add regression coverage for behavior changes.
5. Run:

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run test --workspace @jobseek/copilot-worker
npm run test --workspace @jobseek/extension -- --maxWorkers=1
dotnet test .\companion\JobSeek.sln
npm run test:e2e
```

Keep changes focused and explain any new permissions, network access, or local
data handling in the pull request.

