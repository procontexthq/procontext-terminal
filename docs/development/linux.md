# Linux Development Setup

ProContext Terminal is an Electron app backed by native PTY dependencies. A
plain `pnpm install` installs JavaScript workspace dependencies, but Linux
machines also need system libraries for Electron/Chromium and a display server
for renderer windows.

## Runtime Version

Use Node.js 24 and pnpm 10.28.2:

```bash
nvm install 24
nvm use
corepack enable
corepack prepare pnpm@10.28.2 --activate
```

The repository includes `.nvmrc` and an install-time version guard so unsupported
Node versions fail before native dependencies are installed partially.

## Bootstrap

On Ubuntu/Debian development machines, run:

```bash
pnpm setup:linux
```

The script installs Electron runtime packages, installs workspace dependencies,
rebuilds Electron, verifies Electron's downloaded binary, and fixes the Linux
`chrome-sandbox` helper permissions when present.

The apt package list is shared with CI through
`scripts/install-linux-system-deps.sh`; release packaging passes `--package` to
include packaging-only tools such as `fakeroot`.

Temporary install files are placed under `.cache/setup-tmp` by default. This
keeps setup reliable on SSH instances where `/tmp` may be memory-backed.

On machines with less than 2 GiB of RAM, the script automatically uses
low-memory native dependency settings for install scripts. Normal-sized
machines use pnpm's default install concurrency. You can override the behavior:

```bash
PNPM_CHILD_CONCURRENCY=4 SETUP_NATIVE_JOBS=4 pnpm setup:linux
```

Supported overrides:

```text
PNPM_CHILD_CONCURRENCY      pnpm lifecycle-script concurrency
SETUP_NATIVE_JOBS           node-gyp/make job count for native modules
PNPM_NETWORK_CONCURRENCY    pnpm network concurrency
SETUP_LINUX_LOW_MEMORY_MIB  low-memory threshold; default is 2048
TMPDIR                      install temp directory; default is .cache/setup-tmp
```

The apt packages installed by the script are:

```text
libatk1.0-0
libatk-bridge2.0-0
libcups2
libdrm2
libgbm1
libgtk-3-0
libnss3
libx11-xcb1
libxcomposite1
libxdamage1
libxfixes3
libxkbcommon0
libxrandr2
libxss1
xvfb
libasound2t64 or libasound2
```

## Running Over SSH

Plain SSH sessions usually do not have an X server or `$DISPLAY`, so Electron
cannot show a renderer window directly. For headless validation, use:

```bash
pnpm dev:linux:headless
```

This runs the Electron dev app through `xvfb-run`. It is suitable for smoke
testing and agent/e2e validation, but it does not give you an interactive
visible window. Use X11 forwarding, VNC, noVNC, or a Linux desktop session when
you need to inspect or interact with the app visually.

## Troubleshooting Electron Install

If Electron fails with `Electron uninstall` or `Electron failed to install
correctly`, verify the binary:

```bash
pnpm electron:verify
```

If verification fails:

```bash
unset ELECTRON_SKIP_BINARY_DOWNLOAD
pnpm electron:install
pnpm electron:verify
```

If it still fails, confirm Node.js 24 is active, remove `node_modules`, and run
`pnpm install` again.
