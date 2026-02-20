# Release Runbook

This runbook is the source of truth for Quoroom releases.

## 1. Required Secrets

Configure these in GitHub repository secrets before releasing:

- `APPLE_ID` (or `APPLE_DEVELOPER_ID`)
- `APPLE_APP_SPECIFIC_PASSWORD` (or `APPLE_APP_PASSWORD`)
- `APPLE_TEAM_ID` (or `APPLE_DEVELOPER_TEAM_ID`)
- `CSC_INSTALLER_LINK`
- `CSC_INSTALLER_PASSWORD`
- `CSC_LINK` (optional but recommended for extra binary signing)
- `CSC_KEY_PASSWORD` (required when `CSC_LINK` is set)
- `ES_USERNAME`
- `ES_PASSWORD`
- `ES_CREDENTIAL_ID`
- `ES_TOTP_SECRET`
- `NPM_TOKEN`
- `HOMEBREW_TAP_TOKEN`

Use workflow `Validate Release Secrets` (`.github/workflows/validate-secrets.yml`) to verify secrets.

## 2. Versioning Rules

- Git tag and `package.json` version must match.
- Non-test tags publish to npm and update Homebrew.
- Test tags (`*-test*`) skip npm/Homebrew publishing by design.

## 3. Test Release Procedure (Safe)

1. Push to `main`.
2. Create a test tag: `vX.Y.Z-testN`.
3. Confirm in `Build & Release`:
   - `build-mac` succeeded (signed + notarized pkg).
   - `build-windows` succeeded and produced signed `*-setup.exe`.
   - `build-linux` succeeded and produced `.deb`.
   - `release` succeeded.

## 4. Real Release Procedure

1. Bump version:
   - `npm version <new-version> --no-git-tag-version`
2. Commit and push version files.
3. Create and push real tag:
   - `git tag v<new-version>`
   - `git push origin v<new-version>`
4. Confirm `Build & Release` is fully green.
5. Confirm GitHub Release includes:
   - macOS: `.pkg`, `.tar.gz`
   - Linux: `.deb`, `.tar.gz`
   - Windows: `.exe`, `.zip`
6. Confirm npm publish success for `quoroom@<new-version>`.

## 5. Landing/Download Link Rules

- UI download buttons must resolve from the latest stable non-test release.
- Never rely on test tags for public download links.
- If release assets cannot be resolved, fallback link is:
  - `https://github.com/quoroom-ai/room/releases`

