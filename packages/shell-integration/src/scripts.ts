import { encodePayload } from "./markers.js";
import {
  fullShellIntegrationCapabilities,
  unavailableShellIntegrationCapabilities,
} from "./constants.js";

const fullCapabilities = encodePayload(JSON.stringify(fullShellIntegrationCapabilities));
const lifecycleCapabilities = encodePayload(
  JSON.stringify({
    ...unavailableShellIntegrationCapabilities,
    prompt: true,
    commandStart: true,
    commandFinish: true,
  }),
);
const promptCapabilities = encodePayload(
  JSON.stringify({
    ...unavailableShellIntegrationCapabilities,
    prompt: true,
    cwd: true,
  }),
);

export function bashBootstrap(normalRcFile: string, nonce: string): string {
  return `
__pct_nonce=${shellQuote(nonce)}
if [ -r ${shellQuote(normalRcFile)} ]; then
  . ${shellQuote(normalRcFile)}
fi
__pct_sequence=0
__pct_active_id=
__pct_in_hook=0
__pct_encode() {
  command -v base64 >/dev/null 2>&1 || return 0
  printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\\r\\n'
}
__pct_emit() {
  printf '\\033]633;PCT;1;%s;%s;%s;%s\\033\\\\' "$__pct_nonce" "$1" "$2" "$3"
}
__pct_original_prompt_commands=()
case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
  "declare -a"*)
    __pct_original_prompt_commands=("\${PROMPT_COMMAND[@]}")
    ;;
  *)
    if [ -n "\${PROMPT_COMMAND-}" ]; then
      __pct_original_prompt_commands=("$PROMPT_COMMAND")
    fi
    ;;
esac
__pct_original_debug_trap="$(trap -p DEBUG)"
__pct_original_debug_trap="\${__pct_original_debug_trap#trap -- \\'}"
__pct_original_debug_trap="\${__pct_original_debug_trap%\\' DEBUG}"
__pct_restore_status() {
  return "$1"
}
__pct_prompt() {
  local __pct_status=$?
  local __pct_prompt_status=$__pct_status
  local __pct_prompt_command
  __pct_in_hook=1
  if [ -n "$__pct_active_id" ]; then
    __pct_emit command-finish "$__pct_active_id" "$(__pct_encode "$__pct_status")"
    __pct_active_id=
  fi
  for __pct_prompt_command in "\${__pct_original_prompt_commands[@]}"; do
    __pct_restore_status "$__pct_prompt_status"
    eval "$__pct_prompt_command"
    __pct_prompt_status=$?
  done
  __pct_emit prompt "" "$(__pct_encode "$PWD")"
  __pct_in_hook=0
  return "$__pct_status"
}
__pct_debug() {
  local __pct_status=$?
  [ "$__pct_in_hook" = 1 ] && return
  __pct_in_hook=1
  if [ -n "$__pct_original_debug_trap" ]; then
    __pct_restore_status "$__pct_status"
    eval "$__pct_original_debug_trap"
  fi
  if [ -n "$__pct_active_id" ]; then
    __pct_in_hook=0
    return "$__pct_status"
  fi
  __pct_sequence=$((__pct_sequence + 1))
  __pct_active_id="c$__pct_sequence"
  local __pct_line
  __pct_line="$(HISTTIMEFORMAT= builtin history 1)"
  __pct_line="\${__pct_line#*  }"
  __pct_emit command-start "$__pct_active_id" "$(__pct_encode "$__pct_line")"
  __pct_in_hook=0
  return "$__pct_status"
}
PROMPT_COMMAND=__pct_prompt
if command -v base64 >/dev/null 2>&1; then
  __pct_emit ready "" '${fullCapabilities}'
else
  __pct_emit ready "" '${lifecycleCapabilities}'
fi
trap '__pct_debug' DEBUG
`.trimStart();
}

export function zshBootstrap(
  normalRcFile: string,
  originalZdotdir: string | null,
  nonce: string,
): string {
  const restoreZdotdir = originalZdotdir
    ? `export ZDOTDIR=${shellQuote(originalZdotdir)}`
    : "unset ZDOTDIR";
  return `
typeset -g __pct_nonce=${shellQuote(nonce)}
if [[ -r ${shellQuote(normalRcFile)} ]]; then
  source ${shellQuote(normalRcFile)}
fi
typeset -gi __pct_sequence=0
typeset -g __pct_active_id=
__pct_encode() {
  command -v base64 >/dev/null 2>&1 || return 0
  printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\\r\\n'
}
__pct_emit() {
  printf '\\033]633;PCT;1;%s;%s;%s;%s\\033\\\\' "$__pct_nonce" "$1" "$2" "$3"
}
__pct_preexec() {
  (( __pct_sequence += 1 ))
  __pct_active_id="c$__pct_sequence"
  __pct_emit command-start "$__pct_active_id" "$(__pct_encode "$1")"
}
__pct_precmd() {
  local __pct_status=$?
  if [[ -n "$__pct_active_id" ]]; then
    __pct_emit command-finish "$__pct_active_id" "$(__pct_encode "$__pct_status")"
    __pct_active_id=
  fi
  __pct_emit prompt "" "$(__pct_encode "$PWD")"
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __pct_preexec
add-zsh-hook precmd __pct_precmd
if command -v base64 >/dev/null 2>&1; then
  __pct_emit ready "" '${fullCapabilities}'
else
  __pct_emit ready "" '${lifecycleCapabilities}'
fi
${restoreZdotdir}
`.trimStart();
}

export function fishBootstrap(nonce: string): string {
  return `
set -g __pct_nonce ${shellQuote(nonce)}
set -g __pct_sequence 0
set -g __pct_active_id ""
function __pct_encode
  command -q base64; or return
  printf '%s' "$argv[1]" | base64 | string replace -a '+' '-' | string replace -a '/' '_' | string replace -a '=' '' | string collect
end
function __pct_emit
  printf '\\e]633;PCT;1;%s;%s;%s;%s\\e\\\\' $__pct_nonce $argv[1] $argv[2] $argv[3]
end
function __pct_preexec --on-event fish_preexec
  set -g __pct_sequence (math $__pct_sequence + 1)
  set -g __pct_active_id c$__pct_sequence
  __pct_emit command-start $__pct_active_id (__pct_encode "$argv[1]")
end
function __pct_postexec --on-event fish_postexec
  set -l __pct_status $status
  if test -n "$__pct_active_id"
    __pct_emit command-finish $__pct_active_id (__pct_encode "$__pct_status")
    set -g __pct_active_id ""
  end
end
function __pct_prompt --on-event fish_prompt
  __pct_emit prompt "" (__pct_encode "$PWD")
end
if command -q base64
  __pct_emit ready "" '${fullCapabilities}'
else
  __pct_emit ready "" '${lifecycleCapabilities}'
end
`.trim();
}

export function powershellBootstrap(nonce: string): string {
  return `
$script:__PctNonce = ${powershellQuote(nonce)}
$script:__PctSequence = 0
$script:__PctActiveId = $null
function global:__PctEncode([string]$Value) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
  return $encoded.TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function global:__PctEmit([string]$EventName, [string]$CommandId, [string]$Payload) {
  [Console]::Write(([char]27) + ']633;PCT;1;' + $script:__PctNonce + ';' + $EventName + ';' + $CommandId + ';' + $Payload + ([char]27) + '\\')
}
$script:__PctOriginalPrompt = (Get-Command prompt -CommandType Function -ErrorAction SilentlyContinue).ScriptBlock
$script:__PctPreviousValidation = $null
$script:__PctInstalledValidation = $null
$script:__PctNativeCommand = $false
$script:__PctValidationHandler = {
  param($CommandAst)
  if ($script:__PctPreviousValidation) {
    $script:__PctPreviousValidation.Invoke($CommandAst)
  }
  $firstCommand = $CommandAst.Find({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $false)
  $commandInfo = if ($firstCommand) { Get-Command $firstCommand.GetCommandName() -ErrorAction SilentlyContinue } else { $null }
  $script:__PctNativeCommand = $commandInfo -and $commandInfo.CommandType -eq [System.Management.Automation.CommandTypes]::Application
  $script:__PctSequence += 1
  $script:__PctActiveId = 'c' + $script:__PctSequence
  __PctEmit 'command-start' $script:__PctActiveId (__PctEncode $CommandAst.Extent.Text)
}
function global:__PctEnsureValidation {
  try {
    if (-not (Get-Module PSReadLine)) {
      Import-Module PSReadLine -ErrorAction Stop
    }
    $currentValidation = (Get-PSReadLineOption).CommandValidationHandler
    if (-not [object]::ReferenceEquals($currentValidation, $script:__PctInstalledValidation)) {
      $script:__PctPreviousValidation = $currentValidation
    }
    Set-PSReadLineOption -CommandValidationHandler $script:__PctValidationHandler
    $script:__PctInstalledValidation = (Get-PSReadLineOption).CommandValidationHandler
    $acceptLineBindings = @(Get-PSReadLineKeyHandler -Bound | Where-Object Function -eq 'AcceptLine')
    foreach ($binding in $acceptLineBindings) {
      Set-PSReadLineKeyHandler -Chord $binding.Key -Function ValidateAndAcceptLine
    }
    $validatedBindings = @(
      Get-PSReadLineKeyHandler -Bound | Where-Object Function -eq 'ValidateAndAcceptLine'
    )
    return $validatedBindings.Count -gt 0
  } catch {
    return $false
  }
}
function global:__PctEmitReady([bool]$ValidationInstalled) {
  if ($ValidationInstalled) {
    __PctEmit 'ready' '' '${fullCapabilities}'
  } else {
    __PctEmit 'ready' '' '${promptCapabilities}'
  }
}
function global:prompt {
  $commandSucceeded = $?
  $nativeExitCode = $global:LASTEXITCODE
  if ($script:__PctActiveId) {
    $exitCode = if ($script:__PctNativeCommand) { $nativeExitCode } elseif ($commandSucceeded) { 0 } else { 1 }
    __PctEmit 'command-finish' $script:__PctActiveId (__PctEncode ([string]$exitCode))
    $script:__PctActiveId = $null
    $script:__PctNativeCommand = $false
  }
  $validationInstalled = __PctEnsureValidation
  __PctEmitReady $validationInstalled
  __PctEmit 'prompt' '' (__PctEncode (Get-Location).Path)
  if ($script:__PctOriginalPrompt) { return & $script:__PctOriginalPrompt }
  return 'PS ' + (Get-Location) + '> '
}
$validationInstalled = __PctEnsureValidation
__PctEmitReady $validationInstalled
`.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
