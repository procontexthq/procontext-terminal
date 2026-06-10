#!/usr/bin/env bash
set -euo pipefail

include_packaging_deps=0

for arg in "$@"; do
  case "${arg}" in
    --package)
      include_packaging_deps=1
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Linux system dependency installation is only supported on Linux." >&2
  exit 1
fi

packages=(
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
)

if ((include_packaging_deps)); then
  packages+=(fakeroot)
fi

sudo apt-get update
sudo apt-get install -y "${packages[@]}"

if apt-cache show libasound2t64 >/dev/null 2>&1; then
  sudo apt-get install -y libasound2t64
else
  sudo apt-get install -y libasound2
fi
