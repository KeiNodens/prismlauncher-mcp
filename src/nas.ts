import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// When prism-mcp runs in a session without NAS credentials (e.g. Rin's SSH
// session), the Buffalo NAS share behind the instance symlinks needs an
// explicit connection first. The credential lives ONLY on the PC, DPAPI
// (LocalMachine) encrypted in nas-cred.json; tools/nas-mount.ps1 decrypts
// it inside the PC and runs net use. Opt-in via PRISM_NAS_BOOTSTRAP=1 so
// desktop sessions (which already have their own NAS connection) are
// untouched.
export async function bootstrapNas(): Promise<void> {
  if (process.env.PRISM_NAS_BOOTSTRAP !== "1") return;
  const credFile = process.env.PRISM_NAS_CRED ?? "C:\\dev\\prism\\nas-cred.json";
  if (!fs.existsSync(credFile)) {
    console.error(`prism-mcp: PRISM_NAS_BOOTSTRAP=1 but no cred file at ${credFile}`);
    return;
  }
  const script =
    process.env.PRISM_NAS_MOUNT_SCRIPT ??
    path.join("C:\\dev\\prism\\tools", "nas-mount.ps1");
  try {
    const { stdout } = await execFileP(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, credFile],
      { timeout: 30_000 },
    );
    console.error(`prism-mcp: NAS bootstrap: ${stdout.trim()}`);
  } catch (e) {
    console.error(`prism-mcp: NAS bootstrap failed: ${(e as Error).message}`);
  }
}
