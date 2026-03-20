import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export interface ResolveOptions {
  /** User-configured custom path */
  customPath?: string;
  /** Current platform (defaults to process.platform) */
  platform?: string;
  /** Home directory */
  home?: string;
  /** PATH environment variable */
  pathEnv?: string;
  /** Workspace root directories */
  workspaceDirs?: string[];
  /** File access check (defaults to fs.accessSync) */
  access?: (path: string, mode: number) => void;
}

export function resolvePiBinary(opts: ResolveOptions = {}): string {
  if (opts.customPath) return opts.customPath;

  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? "";
  const workspaceDirs = opts.workspaceDirs ?? [];
  const access = opts.access ?? accessSync;

  const isWin = platform === "win32";
  // On Windows, npm/pnpm create .cmd shims; also check .exe and .ps1
  const names = isWin ? ["pi.cmd", "pi.exe", "pi.ps1"] : ["pi"];
  // Windows lacks Unix-style execute permission; just check the file exists
  const accessFlag = isWin ? constants.F_OK : constants.X_OK;

  // Check workspace-local node_modules/.bin first (respects monorepos / multi-root)
  const workspaceCandidates = workspaceDirs.flatMap((dir) =>
    names.map((n) => join(dir, "node_modules", ".bin", n)),
  );

  // Then well-known global paths
  const globalCandidates = isWin
    ? []
    : [`${home}/.bun/bin/pi`, `${home}/.local/bin/pi`, `${home}/.npm-global/bin/pi`];

  const candidates = [...workspaceCandidates, ...globalCandidates];
  for (const c of candidates) {
    try {
      access(c, accessFlag);
      return c;
    } catch {}
  }

  // Search OS PATH
  const pathDirs = pathEnv.split(isWin ? ";" : ":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const n of names) {
      const full = join(dir, n);
      try {
        access(full, accessFlag);
        return full;
      } catch {}
    }
  }

  return "pi";
}
