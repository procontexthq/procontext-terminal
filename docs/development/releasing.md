# Release Validation

ProContext Terminal keeps ordinary local and pull-request packaging unsigned.
Production releases use a separate Builder configuration and fail before
packaging unless the release tag, signing credentials, notarization inputs, and
GitHub provenance context are complete.

## Release Tag

The desktop package version and Git tag must match exactly. Version `0.1.0`
must be released from tag `v0.1.0`.

The Release workflow runs automatically for `v*` tags. A manual workflow
dispatch must select the version tag rather than a branch. The input validator
rejects any other ref before dependency installation or packaging.

## Repository Secrets

Windows releases require:

- `WINDOWS_CSC_LINK`: Electron Builder-compatible certificate URL, file data,
  or base64-encoded certificate.
- `WINDOWS_CSC_KEY_PASSWORD`: password for that certificate.

macOS releases require:

- `MACOS_CSC_LINK`: Electron Builder-compatible Developer ID certificate.
- `MACOS_CSC_KEY_PASSWORD`: password for that certificate.
- `APPLE_ID`: Apple account used with notarytool.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for that account.
- `APPLE_TEAM_ID`: Apple Developer team identifier.

Linux artifacts do not require a platform code-signing secret. They still
require the tag, repository, commit, and GitHub OIDC provenance context.

The validation scripts report only missing variable names. They never print
secret values.

## Local Checks

Build and smoke-test the unsigned package for the current platform:

```bash
pnpm test:package
```

Build an unsigned distributable with the ordinary platform script:

```bash
pnpm package:mac
pnpm package:win
pnpm package:linux
```

Structural artifact validation is available for local unsigned output:

```bash
node apps/desktop/scripts/verify-release-artifacts.mjs \
  --platform linux \
  --dist apps/desktop/dist \
  --package-json apps/desktop/package.json \
  --structure-only
```

`--structure-only` is never used by the Release workflow.

## Credentialed Release Checks

Release jobs build with `electron-builder.release.yml`. Before upload, each job
uses native platform tooling:

- macOS verifies the DMG, its signature, the mounted app signature, the
  stapled notarization ticket, Gatekeeper acceptance, packaged `node-pty`, and
  launches the mounted application executable.
- Windows verifies Authenticode on both the NSIS installer and the application
  executable produced by a silent installation, checks installed `node-pty`,
  launches the installed app, and runs the uninstaller.
- Linux extracts the AppImage and deb, validates their native formats and
  entrypoints, checks packaged `node-pty`, and launches the extracted app from
  both artifacts.

Only artifacts that pass those checks are uploaded. GitHub then creates a
build-provenance attestation for every uploaded installer, and the workflow
immediately verifies each attestation against the repository before completing.

The first credentialed tagged run remains the final confirmation that the
repository secrets and external signing services are configured correctly.
