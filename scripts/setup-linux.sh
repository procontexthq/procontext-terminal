#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "setup:linux is only supported on Linux." >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

node scripts/check-node-version.mjs

export TMPDIR="${TMPDIR:-${PWD}/.cache/setup-tmp}"
mkdir -p "${TMPDIR}"

require_positive_integer() {
  local name="$1"
  local value="$2"

  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    echo "${name} must be a positive integer." >&2
    exit 1
  fi
}

total_memory_mib=0
if [[ -r /proc/meminfo ]]; then
  total_memory_kib="$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)"
  if [[ "${total_memory_kib}" =~ ^[0-9]+$ ]]; then
    total_memory_mib=$((total_memory_kib / 1024))
  fi
fi

low_memory_threshold_mib="${SETUP_LINUX_LOW_MEMORY_MIB:-2048}"
require_positive_integer "SETUP_LINUX_LOW_MEMORY_MIB" "${low_memory_threshold_mib}"

pnpm_install_args=(install)
native_build_jobs="${SETUP_NATIVE_JOBS:-}"

if [[ -n "${PNPM_CHILD_CONCURRENCY:-}" ]]; then
  require_positive_integer "PNPM_CHILD_CONCURRENCY" "${PNPM_CHILD_CONCURRENCY}"
  pnpm_install_args+=("--child-concurrency=${PNPM_CHILD_CONCURRENCY}")
elif ((total_memory_mib > 0 && total_memory_mib < low_memory_threshold_mib)); then
  pnpm_install_args+=("--child-concurrency=1")
  native_build_jobs="${native_build_jobs:-1}"
  echo "Detected ${total_memory_mib} MiB RAM; using low-memory native install settings."
  echo "Override with PNPM_CHILD_CONCURRENCY, SETUP_NATIVE_JOBS, or SETUP_LINUX_LOW_MEMORY_MIB."
fi

if [[ -n "${PNPM_NETWORK_CONCURRENCY:-}" ]]; then
  require_positive_integer "PNPM_NETWORK_CONCURRENCY" "${PNPM_NETWORK_CONCURRENCY}"
  pnpm_install_args+=("--network-concurrency=${PNPM_NETWORK_CONCURRENCY}")
fi

if [[ -n "${native_build_jobs}" ]]; then
  require_positive_integer "SETUP_NATIVE_JOBS" "${native_build_jobs}"
  export MAKEFLAGS="${MAKEFLAGS:--j${native_build_jobs}}"
  export npm_config_jobs="${npm_config_jobs:-${native_build_jobs}}"
fi

bash scripts/install-linux-system-deps.sh

unset ELECTRON_SKIP_BINARY_DOWNLOAD
pnpm "${pnpm_install_args[@]}"
pnpm electron:install
pnpm electron:verify

electron_package_dir="$(
  pnpm --filter @terminal/desktop exec node -e "const {dirname}=require('node:path'); console.log(dirname(require.resolve('electron/package.json')))"
)"
chrome_sandbox="${electron_package_dir}/dist/chrome-sandbox"

if [[ -f "${chrome_sandbox}" ]]; then
  sudo chown root:root "${chrome_sandbox}"
  sudo chmod 4755 "${chrome_sandbox}"
fi

echo "Linux development setup complete."
echo "For headless SSH development, run: pnpm dev:linux:headless"
