import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function openFolder(
  folder,
  { platform = process.platform, spawnProcess = spawn, timeoutMs = 10000 } = {},
) {
  const windows = platform === "win32";
  const command = windows
    ? "powershell.exe"
    : platform === "darwin"
      ? "open"
      : "xdg-open";
  const args = windows
    ? [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./windows-open-folder.ps1", import.meta.url)),
      ]
    : [folder];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "",
      stdout = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          "Windows did not acknowledge the folder request in time. Try opening it again.",
        ),
      );
      child.kill();
    }, timeoutMs);
    timer.unref();
    child.stdout.on(
      "data",
      (chunk) => (stdout = (stdout + chunk.toString()).slice(0, 8000)),
    );
    child.stderr.on(
      "data",
      (chunk) => (stderr = (stderr + chunk.toString()).slice(0, 8000)),
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              `The file manager rejected this folder request (${code}).`,
          ),
        );
        return;
      }
      if (windows) {
        try {
          if (JSON.parse(stdout).ok !== true) throw new Error();
        } catch {
          reject(new Error("Windows did not acknowledge the folder request."));
          return;
        }
      }
      resolve();
    });
    child.stdin.on("error", () => {});
    child.stdin.end(windows ? JSON.stringify({ folder }) + "\n" : undefined);
  });
}
