import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  detectSupportedShell,
  prepareShellIntegrationLaunch,
  type ShellLaunchConfiguration,
} from "../src/index";

const nonce = "AQEBAQEBAQEBAQEBAQEBAQ";

describe("shell integration launch preparation", () => {
  it.each([
    ["/bin/bash", "bash"],
    ["/opt/homebrew/bin/zsh", "zsh"],
    ["/usr/local/bin/fish", "fish"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell"],
    ["/bin/sh", null],
    ["C:\\Windows\\System32\\cmd.exe", null],
  ] as const)("detects %s as %s", (executable, expected) => {
    expect(detectSupportedShell(executable)).toBe(expected);
  });

  it("creates a private Bash rcfile that chains normal startup and hooks", () => {
    const prepared = prepare("/bin/bash", { HOME: "/home/test" });
    const rcfile = prepared.launch.args[1];

    expect(prepared.launch.args[0]).toBe("--rcfile");
    expect(rcfile).toBeTruthy();
    expect(readFileSync(rcfile!, "utf8")).toContain(".bashrc");
    expect(readFileSync(rcfile!, "utf8")).toContain("PROMPT_COMMAND");
    expect(readFileSync(rcfile!, "utf8")).toContain("DEBUG");
    expect(readFileSync(rcfile!, "utf8")).toContain("__pct_original_debug_trap");
    expect(prepared.integration.status).toBe("initializing");
    expect(prepared.nonce).toBe(nonce);
    expect(prepared.temporaryPath && existsSync(prepared.temporaryPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(prepared.temporaryPath!).mode & 0o777).toBe(0o700);
      expect(statSync(rcfile!).mode & 0o777).toBe(0o600);
    }

    prepared.cleanup();
    expect(prepared.temporaryPath && existsSync(prepared.temporaryPath)).toBe(false);
  });

  it("creates an isolated Zsh startup directory that forwards user files", () => {
    const prepared = prepare("/bin/zsh", {
      HOME: "/home/test",
      ZDOTDIR: "/home/test/.config/zsh",
    });
    const zdotdir = prepared.launch.env.ZDOTDIR;

    expect(zdotdir).toBe(prepared.temporaryPath);
    expect(readFileSync(join(zdotdir!, ".zshenv"), "utf8")).toContain(
      "/home/test/.config/zsh/.zshenv",
    );
    expect(readFileSync(join(zdotdir!, ".zshenv"), "utf8")).toContain(
      `export ZDOTDIR='${zdotdir}'`,
    );
    expect(readFileSync(join(zdotdir!, ".zshrc"), "utf8")).toContain("add-zsh-hook");
    expect(readFileSync(join(zdotdir!, ".zshrc"), "utf8")).toContain(
      "/home/test/.config/zsh/.zshrc",
    );
    prepared.cleanup();
  });

  it("adds Fish post-configuration event hooks", () => {
    const prepared = prepare("/usr/bin/fish", { HOME: "/home/test" });
    const commandIndex = prepared.launch.args.indexOf("--init-command");
    const initFile = join(prepared.temporaryPath!, "fish-init.fish");
    const script = readFileSync(initFile, "utf8");

    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.launch.args[commandIndex + 1]).toContain(initFile);
    expect(script).toContain("fish_preexec");
    expect(script).toContain("fish_postexec");
    expect(script).toContain("fish_prompt");
    prepared.cleanup();
  });

  it("adds post-profile PowerShell prompt and PSReadLine hooks", () => {
    const prepared = prepare("C:\\Program Files\\PowerShell\\7\\pwsh.exe", {
      USERPROFILE: "C:\\Users\\test",
    });
    const commandIndex = prepared.launch.args.indexOf("-Command");
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    const bootstrapCommand = prepared.launch.args[commandIndex + 1];
    const bootstrapFile = join(prepared.temporaryPath!, "powershell-bootstrap.ps1");
    const script = readFileSync(bootstrapFile, "utf8");

    expect(prepared.launch.args).toContain("-NoExit");
    expect(bootstrapCommand).toContain(bootstrapFile.replaceAll("'", "''"));
    expect(prepared.temporaryPath && existsSync(prepared.temporaryPath)).toBe(true);
    expect(script).toContain("Set-PSReadLineOption");
    expect(script).toContain("CommandValidationHandler");
    expect(script).toContain("function global:__PctEnsureValidation");
    expect(script).toContain("Import-Module PSReadLine -ErrorAction Stop");
    expect(script).toContain("$script:__PctPreviousValidationCaptured");
    expect(script.match(/Set-PSReadLineOption -CommandValidationHandler/g)).toHaveLength(1);
    expect(script).toContain("function global:prompt");
    expect(script).toContain("$validationInstalled = __PctEnsureValidation");
    prepared.cleanup();
    expect(prepared.temporaryPath && existsSync(prepared.temporaryPath)).toBe(false);
  });

  it("does not expose the session nonce through the inherited environment", () => {
    for (const executable of ["/bin/bash", "/bin/zsh", "/usr/bin/fish", "pwsh.exe"]) {
      const prepared = prepare(executable, { HOME: "/home/test" });
      expect(prepared.launch.env.PCT_SHELL_INTEGRATION_NONCE).toBeUndefined();
      prepared.cleanup();
    }
  });

  it("leaves unsupported shells unchanged and creates no temporary resources", () => {
    const launch = baseLaunch("/bin/sh", { HOME: "/home/test" });
    const prepared = prepareShellIntegrationLaunch(launch, {
      nonce,
      temporaryRoot: tmpdir(),
    });

    expect(prepared.launch).toEqual(launch);
    expect(prepared.integration.status).toBe("unavailable");
    expect(prepared.nonce).toBeUndefined();
    expect(prepared.temporaryPath).toBeUndefined();
    prepared.cleanup();
  });
});

function prepare(executable: string, env: Record<string, string>) {
  return prepareShellIntegrationLaunch(baseLaunch(executable, env), {
    nonce,
    temporaryRoot: tmpdir(),
  });
}

function baseLaunch(executable: string, env: Record<string, string>): ShellLaunchConfiguration {
  return {
    executable,
    args: [],
    cwd: env.HOME ?? env.USERPROFILE ?? "/tmp",
    env,
  };
}
