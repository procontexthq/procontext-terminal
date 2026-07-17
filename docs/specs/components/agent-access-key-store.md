# Agent Access Key Store

## Status

Accepted component architecture.

## Purpose

The agent access key store owns the single persistent bearer credential used
to authenticate local agent clients. It is a main-process credential boundary,
not part of ordinary terminal settings or the runtime gateway descriptor.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Generate one cryptographically random 256-bit access key for each Electron
  `userData` profile when no key exists.
- Reuse that key across app and gateway restarts until the human explicitly
  regenerates it or removes the app profile.
- Persist the key in a dedicated versioned credential file under `userData`,
  using an atomic same-directory replacement and restrictive file permissions.
- Keep the access key separate from `settings.json`, renderer configuration,
  gateway descriptors, diagnostics, audits, terminal data, and recordings.
- Provide non-secret metadata such as a fingerprint and creation time for the
  renderer settings surface.
- Copy the access key only after an explicit human action, using the Electron
  main-process clipboard API so the raw value is not returned through IPC.
- Serialize regeneration so a newly generated key is persisted before it
  becomes the gateway's active credential.

The file system and the platform user-profile boundary protect the persisted
credential. Platforms that cannot enforce the requested file mode still rely
on the access controls of Electron's per-user application data directory.

## Lifecycle

- Missing credential data creates and persists a new access key before the
  gateway starts.
- Valid credential data is loaded without changing the key.
- Invalid credential contents are replaced with a newly persisted key and a
  structured warning that contains no credential material.
- An unreadable credential or failed write prevents the gateway from starting
  or rotating with an unpersisted key; the human terminal application remains
  available.
- Failed regeneration leaves the current key and authenticated connections
  unchanged.
- Successful regeneration activates the new key immediately and disconnects
  existing agent connections without closing terminal sessions or PTYs.
- App shutdown removes the ephemeral gateway descriptor but retains the access
  key for the next launch.
- Electron admits only one main process for a `userData` profile so first-use
  key creation and the shared runtime descriptor cannot race across processes.

## Renderer Surface

The renderer may receive only non-secret key metadata and operation outcomes.
It must never receive the raw access key, encrypted credential bytes, a key
suffix, or clipboard contents. The visible key mask is static UI text rather
than a transformed secret.

How an external agent client stores or injects a manually copied key is outside
this component and repository's responsibility.

## Testing Expectations

- First use generates and persists one valid 256-bit access key.
- Later loads reuse the same key.
- Writes are atomic and request restrictive permissions on macOS, Linux, and
  Windows.
- Invalid contents recover with a new persisted key without logging the old or
  new value; I/O failures fail closed.
- Concurrent regeneration requests cannot activate a key different from the
  final persisted key.
- Clipboard copy is explicit and the key never appears in renderer results,
  logs, audits, or ordinary settings.
- Successful regeneration invalidates authenticated connections while terminal
  sessions remain alive.
