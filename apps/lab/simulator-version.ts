import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Build-time simulator version for run headers and exports (ADR-0028): `<lab package version>+<short
 * commit>`, with `-dirty` when the working tree has uncommitted changes. Same format as
 * `formatSimulatorVersion` in `@agentsim/scenarios` (the Vite config cannot import workspace sources).
 * Without git (e.g. a source tarball) the commit is `unknown`.
 */
export function simulatorVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  const commit = git(["rev-parse", "--short=7", "HEAD"]);
  if (commit === undefined) return `${pkg.version}+unknown`;
  const dirty = (git(["status", "--porcelain"]) ?? "") !== "";
  return `${pkg.version}+${commit}${dirty ? "-dirty" : ""}`;
}
