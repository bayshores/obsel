/**
 * Say, after the summary, which agent CLI this run did not exercise.
 *
 * `runners.live.test.ts` skips a runner that is not installed, and that skip breaks a
 * rule the rest of this suite keeps absolutely: `reachable.ts` refuses rather than skips,
 * because a green run without the real thing reports on a path nothing exercised.
 *
 * The skip is still the right trade. Requiring both CLIs would make a machine with one
 * unable to run the suite at all, which is the wall the second runner exists to remove.
 * What is not acceptable is a green summary that reads as evidence about both, so this
 * prints the gap where nobody can miss it: after the pass/fail counts, as the last thing
 * on screen. A skipped `describe` line scrolls off the top of a ten-file run; this does
 * not.
 *
 * A `globalSetup` teardown rather than an `afterAll`, because test-file output is grouped
 * with its file and this has to come after every file, below the summary.
 *
 * It reports and never fails. Failing would be the requirement this file exists to avoid.
 */

import { execFileSync } from "node:child_process";

const RUNNERS = [
  { cli: "codex", product: "Codex", install: "the Codex CLI" },
  { cli: "claude", product: "Claude Code", install: "Claude Code" },
];

/** The same question `runners.live.test.ts` asks, asked the same way. */
function installed(cli: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${cli}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function setup(): void {
  // Nothing to stand up. The suite's prerequisites are each asserted by the file
  // that needs them, which is where the failure is readable.
}

export function teardown(): void {
  const missing = RUNNERS.filter((runner) => !installed(runner.cli));

  // The report itself, not logging: it is the only place the gap is stated.
  const say = console.log;

  if (missing.length === 0) {
    say("");
    say("  Agent runners: both Codex and Claude Code ran a real session.");
    return;
  }

  if (missing.length === RUNNERS.length) {
    // Not reachable in practice: every file with a runner as its subject calls
    // `requireRunner`, which throws. Printed anyway, because a suite that somehow
    // went green here would be claiming the most and proving the least.
    say("");
    say("  NOT COVERED: no agent CLI is installed, so no real agent session ran at all.");
    return;
  }

  const gap = missing[0];
  const covered = RUNNERS.find((runner) => runner.cli !== gap.cli)!;
  say("");
  say(`  NOT COVERED: ${gap.product}. It is not installed, so its invocation never ran.`);
  say(`  This run is evidence about ${covered.product} only, not about both runners.`);
  say(`  To cover it: install ${gap.install}, sign in, and run this suite again.`);
}
