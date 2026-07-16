import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultTimeoutMs = 60_000;

export async function smokeReleaseExecutable(
  executable,
  { prefixArgs = [], timeoutMs = defaultTimeoutMs } = {},
) {
  const remoteDebuggingPort = await allocatePort();
  const userDataDirectory = await mkdtemp(join(tmpdir(), "terminal-release-smoke-"));
  const output = { stdout: "", stderr: "" };
  let launchError;
  let child;

  try {
    child = spawn(
      executable,
      [
        ...prefixArgs,
        `--remote-debugging-port=${remoteDebuggingPort}`,
        `--user-data-dir=${userDataDirectory}`,
      ],
      {
        detached: process.platform !== "win32",
        env: releaseSmokeEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.once("error", (error) => {
      launchError = error;
    });
    captureBounded(child.stdout, output, "stdout");
    captureBounded(child.stderr, output, "stderr");

    const version = await waitForRendererEndpoint(
      remoteDebuggingPort,
      child,
      () => launchError,
      timeoutMs,
      output,
    );
    return {
      status: "launched",
      executable,
      browser: version.Browser,
    };
  } finally {
    if (child) {
      terminateProcessTree(child);
      if (!(await waitForExit(child, 5_000))) {
        terminateProcessTree(child, "SIGKILL");
        await waitForExit(child, 5_000);
      }
    }
    await rm(userDataDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  }
}

async function waitForRendererEndpoint(port, child, getLaunchError, timeoutMs, output) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let lastRequestError;

  while (Date.now() < deadline) {
    const launchError = getLaunchError();
    if (launchError) throw launchError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Release executable exited before its renderer endpoint was ready.${formatOutput(output)}`,
      );
    }

    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const version = await response.json();
        if (typeof version?.Browser !== "string" || version.Browser.length === 0) {
          throw new Error("Renderer endpoint did not report a Browser version.");
        }
        return version;
      }
      lastRequestError = new Error(`Renderer endpoint returned HTTP ${response.status}.`);
    } catch (error) {
      lastRequestError = error;
    }
    await delay(100);
  }

  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${endpoint}: ${lastRequestError?.message ?? "no response"}.${formatOutput(output)}`,
  );
}

function releaseSmokeEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "win32" && !env.ComSpec) {
    env.ComSpec = "C:\\Windows\\System32\\cmd.exe";
  }
  if (process.platform !== "win32" && !env.SHELL) env.SHELL = "/bin/sh";
  return env;
}

function captureBounded(stream, output, key) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    output[key] = `${output[key]}${chunk}`.slice(-4_096);
  });
}

function formatOutput(output) {
  const combined = [output.stdout.trim(), output.stderr.trim()].filter(Boolean).join("\n");
  return combined ? ` Last output:\n${combined}` : "";
}

function terminateProcessTree(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a renderer debugging port.");
  }
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function parseArgs(values) {
  const parsed = { arguments: [], timeoutMs: defaultTimeoutMs };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--executable") parsed.executable = values[++index];
    else if (argument === "--argument") parsed.arguments.push(values[++index]);
    else if (argument === "--timeout-ms") parsed.timeoutMs = Number(values[++index]);
    else throw new Error(`Unknown argument ${argument}.`);
  }
  if (!parsed.executable) throw new Error("Missing --executable.");
  if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number.");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const args = parseArgs(process.argv.slice(2));
  const result = await smokeReleaseExecutable(args.executable, {
    prefixArgs: args.arguments,
    timeoutMs: args.timeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
}
