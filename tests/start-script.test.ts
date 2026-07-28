/**
 * The launcher's refusals, run as the launcher.
 *
 * `scripts/start.sh` is the file a judge reaches obsel through, and the half of it
 * that matters most is the half that runs when something is missing. A judge who
 * hits a wall of shell errors is a judge who stops, so each refusal has to name
 * what was observed and the one thing to do about it.
 *
 * Nothing here is stood in for. The unreachable Docker daemon is a real `docker`
 * binary pointed at a socket path that genuinely does not exist, which is the same
 * refusal a judge gets when Docker Desktop is installed and has not been opened.
 * The script really runs, in a real temporary directory, and what the assertions
 * read is its real output.
 *
 * Two refusals are not automated here and are recorded in `docs/verification.md`
 * with their dates instead. Removing Node means a PATH without it, and the script
 * deliberately adds `/usr/local/bin` back before looking, so a machine with Node
 * installed there would pass a test that claims Node is missing. Docker absent
 * rather than unreachable has the same shape. Both were produced by hand on a
 * machine where they are genuinely true.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const REPO = new URL("..", import.meta.url).pathname;

/**
 * A socket path nothing is listening on, and nothing can be: the directory does
 * not exist. Asserted below before it is relied on.
 */
const DEAD_DOCKER = "unix:///nonexistent-so-docker-cannot-answer/docker.sock";

const made: string[] = [];

/**
 * A copy of just the files the launcher touches before its first refusal.
 *
 * A copy rather than the repository itself, so that "it created nothing" is a
 * claim about a directory this test owns. `.env.example` comes along because
 * creating `.env.local` from it is the first thing the script would write.
 */
function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "obsel-launcher-"));
  made.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(REPO, "scripts/start.sh"), join(root, "scripts/start.sh"));
  copyFileSync(join(REPO, ".env.example"), join(root, ".env.example"));
  copyFileSync(join(REPO, "Start obsel.command"), join(root, "Start obsel.command"));
  return root;
}

/** The launcher, run the way a double-click runs it: no arguments, no input. */
function runLauncher(root: string, file: string, cwd: string) {
  return spawnSync("bash", [join(root, file)], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, DOCKER_HOST: DEAD_DOCKER },
  });
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the launcher refuses in a way a judge can act on", () => {
  beforeAll(() => {
    // Both halves of the setup have to be real, or the tests below prove nothing.
    // `docker` must be installed, so that what fails is the daemon and not the
    // lookup, and the socket must genuinely not answer.
    const installed = spawnSync("docker", ["--version"], { encoding: "utf8" });
    if (installed.status !== 0) {
      throw new Error(
        "these tests need the docker CLI installed, so that the refusal under test " +
          "is an unreachable daemon rather than a missing binary.\n" +
          "  Fix: install Docker Desktop, https://www.docker.com/products/docker-desktop/",
      );
    }
    const reachable = spawnSync("docker", ["info"], {
      encoding: "utf8",
      env: { ...process.env, DOCKER_HOST: DEAD_DOCKER },
    });
    if (reachable.status === 0) {
      throw new Error(`${DEAD_DOCKER} answered; this test needs a socket nothing is on`);
    }
  });

  it("names the daemon, not the binary, when Docker is installed and not running", () => {
    const root = scratchRepo();
    const run = runLauncher(root, "scripts/start.sh", root);

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("Step 1 of 9: Docker");
    expect(run.stdout).toContain("Docker is installed but not running");
    // The fix is the reader's next action, and it is the whole point of the message.
    expect(run.stdout).toContain("open Docker Desktop");
    // Not the other refusal: a judge sent to install Docker they already have
    // is worse off than one told nothing.
    expect(run.stdout).not.toContain("Docker is not installed");
  });

  it("writes nothing into the folder when it stops at the first step", () => {
    const root = scratchRepo();
    runLauncher(root, "scripts/start.sh", root);

    // The two things the script creates, neither of which it reached.
    expect(existsSync(join(root, ".env.local"))).toBe(false);
    expect(existsSync(join(root, "agents/.venv"))).toBe(false);
  });

  it("finds its folder when started from somewhere else, as a double-click does", () => {
    // Finder runs a .command file from the user's home directory rather than from
    // the folder it lives in, so a launcher that trusted the working directory
    // would look for obsel in the wrong place. The refusal is incidental here;
    // what is under test is the folder it reports having entered.
    const root = scratchRepo();
    const run = runLauncher(root, "Start obsel.command", tmpdir());

    expect(run.stdout).toContain(`Folder: ${root}`);
    expect(run.stdout).toContain("Step 1 of 9: Docker");
  });
});

describe("the launcher parses under the shell that will run it", () => {
  it("has no syntax error under this machine's /bin/bash", () => {
    // macOS ships bash 3.2, which is what a double-clicked .command gets, and it
    // rejects syntax that newer bash accepts. `-n` parses without executing.
    for (const file of ["scripts/start.sh", "Start obsel.command"]) {
      expect(() =>
        execFileSync("/bin/bash", ["-n", join(REPO, file)], { encoding: "utf8" }),
      ).not.toThrow();
    }
  });
});
