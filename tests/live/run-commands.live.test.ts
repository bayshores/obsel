/**
 * `agents/run.py`'s commands that need no model, against a real obsel and a real DataHub.
 *
 * `run.py` is the demo driver. Five of its seven commands (`run`, `rerun-same`, `change`,
 * `repair`, and `setup`) reach a live Codex session or DataHub's vocabulary registration,
 * and are covered elsewhere: the guards those commands print are checked offline by
 * `python -m agents.run self-check`, and the Codex invocation itself by
 * `codex.live.test.ts`. `register` and `reset` are the two that talk only to obsel, so
 * they can be driven end to end here — along with `repair`'s one Codex-free path, the
 * clean board, which reads the real swarm and must decide there is nothing to do.
 *
 * They are worth driving, because both own a failure that is silent by nature.
 *
 * `register` is where the Python and TypeScript halves agree — or fail to — about what a
 * task's URN is. `pipeline.task_urn` and `src/server/datahub/urns.ts` build the same string
 * from the same `OBSEL_FLOW_ID`, and a URN differing by one character is not an error in
 * DataHub, it is a **different entity**. obsel would then traverse a graph whose nodes the
 * agents never wrote to. `cmd_register` compares the two and stops; that comparison is
 * checked below by genuinely misconfiguring the two sides against each other.
 *
 * `reset` is the only destructive path in the repository, and its ordering carries a rule:
 * obsel's half goes first, and the local tables are deleted only once that succeeded.
 * Clearing local files while DataHub still holds the fingerprints leaves a baseline on one
 * side and nothing on the other. The failing half of that rule is checked offline against a
 * port nothing is listening on; the succeeding half is checked here.
 *
 * Nothing is stood in for. Real `python3 -m agents.run`, real HTTP, real DataHub reads.
 * The local files land under a temporary root, which is the reason `cmd_reset` takes one.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { startObsel } from "./obsel-server";
import type { ObselServer } from "./obsel-server";
import { requireDataHub, requireStaleTag, requireUvx } from "./reachable";

const { readTask } = await import("@/src/server/datahub/client");
const { closeMcpClient } = await import("@/src/server/datahub/mcp");
const { datasetUrn, taskUrn } = await import("@/src/server/datahub/urns");

const REPO = new URL("../../", import.meta.url).pathname;
const FLOW_ID = "obsel_integration_tests";
/** Not 3000, and not 3099: the operator's `pnpm dev` and `worker.live.test.ts` hold those. */
const PORT = 3098;

/** The four the demo declares, in `agents/pipeline.py`. */
const DEMO_TASKS = ["clean_orders", "build_revenue", "write_report", "write_docs"] as const;

let obselServer: ObselServer;

interface Ran {
  code: number;
  output: string;
}

/**
 * Run `agents.run` the way the demo tells an operator to.
 *
 * `spawnSync` rather than `execFileSync`, because a non-zero exit is the subject of two of
 * these tests rather than an error in them: `execFileSync` throws on it and the exit code
 * is what has to be asserted.
 */
function run(args: string[], env: Record<string, string> = {}): Ran {
  const result = spawnSync("python3", ["-m", "agents.run", ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, OBSEL_FLOW_ID: FLOW_ID, ...env },
  });
  return {
    code: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Call one of `run.py`'s command functions directly, so a root can be passed to it. */
function callCommand(body: string): Ran {
  const script = [
    "import argparse",
    "from pathlib import Path",
    "from agents import run",
    `args = argparse.Namespace(obsel_url=${JSON.stringify(obselServer.url)}, capture=None)`,
    body,
  ].join("\n");
  const result = spawnSync("python3", ["-c", script], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, OBSEL_FLOW_ID: FLOW_ID },
  });
  return {
    code: result.status ?? -1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

beforeAll(async () => {
  await requireDataHub();
  await requireStaleTag();
  requireUvx();

  obselServer = await startObsel(PORT, FLOW_ID);

  return async () => {
    await obselServer.stop();
    await closeMcpClient();
  };
});

describe("register puts the demo's four tasks into DataHub", () => {
  it("registers all four and reports each one's URN", () => {
    const { code, output } = run(["register", "--obsel-url", obselServer.url]);

    expect(output).not.toContain("MISMATCH");
    expect(code).toBe(0);
    for (const name of DEMO_TASKS) {
      expect(output).toContain(name);
    }
  });

  it("leaves each task readable in DataHub, at registered", async () => {
    // Read back out of DataHub rather than inferred from the command exiting 0. The two
    // can disagree: registration is confirmed by polling, and what that polling proves
    // is exactly what is re-read here.
    for (const name of DEMO_TASKS) {
      const record = await readTask(taskUrn(name));
      expect(record, `${name} should be readable in DataHub`).not.toBeNull();
      expect(record?.status).toBe("registered");
    }
  });

  it("registers the words the board and DataHub both show", async () => {
    /*
     * `title` and `description` come from `pipeline.py` and are written as the DataJob's
     * own fields, so DataHub's UI and obsel's board describe a task the same way. A judge
     * who clicks through from the board to DataHub is the person this is for.
     */
    const cleaner = await readTask(taskUrn("clean_orders"));

    expect(cleaner?.title).toBe("Orders cleaner");
    expect(cleaner?.description).toContain("cleans the raw orders export");
  });

  it("registers the lineage the cascade is later traversed over", async () => {
    /*
     * The edges, not just the nodes. `build_revenue` reading `clean_orders` is the first
     * hop of the demo's cascade, and a task registered without its edges would be
     * traversed straight past.
     *
     * Compared as full dataset URNs rather than short names, deliberately. The agents send
     * `"clean_orders"` and obsel expands it through `datasetUrn`; asserting on the short
     * name would pass even if the two sides namespaced it differently, which is the same
     * class of silent disagreement the URN check above exists for.
     */
    const revenue = await readTask(taskUrn("build_revenue"));

    expect(revenue?.reads).toContain(datasetUrn("clean_orders"));
    expect(revenue?.writes).toContain(datasetUrn("daily_revenue"));
  });
});

describe("the Python and TypeScript halves have to agree about URNs", () => {
  it("stops when the two sides are pointed at different flows", () => {
    /*
     * A genuine misconfiguration, produced the way an operator would produce it: the
     * agents are given one `OBSEL_FLOW_ID` and the running obsel has another. This is not
     * hypothetical — an earlier run of this suite registered a task into the demo's flow
     * because the variable was set after the module that reads it had already loaded.
     *
     * What makes it worth a test is that DataHub does not object. obsel registers the task
     * under ITS flow and answers successfully; the agents then compute a URN under THEIRS.
     * Both sides think they succeeded, and the disagreement only surfaces later as a
     * cascade that silently reaches nothing. `cmd_register` compares the two strings for
     * that reason, and this is the check that it still does.
     */
    const { code, output } = run(["register", "--obsel-url", obselServer.url], {
      OBSEL_FLOW_ID: "a_different_flow",
    });

    expect(code).toBe(1);
    expect(output).toContain("MISMATCH");
    expect(output).toContain("lineage traversal would miss this task");
    // Both URNs are printed, because "they differ" is not enough to fix it with.
    expect(output).toContain("a_different_flow");
    expect(output).toContain(FLOW_ID);
  });
});

describe("reset returns obsel to its pre-run state", () => {
  it("puts the registered tasks back and says which", () => {
    const root = mkdtempSync(join(tmpdir(), "obsel-reset-"));
    try {
      const { code, output } = callCommand(
        `raise SystemExit(run.cmd_reset(args, Path(${JSON.stringify(root)})))`,
      );

      expect(code).toBe(0);
      expect(output).toContain("back to registered");
      // The four this file registered are among them. Other live suites register into
      // the same flow, so this is a containment check rather than an equality one.
      for (const name of DEMO_TASKS) {
        expect(output).toContain(name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("deletes this machine's run output, under the root it was given", () => {
    const root = mkdtempSync(join(tmpdir(), "obsel-reset-"));
    try {
      // Real files in the three directories a run leaves behind.
      for (const directory of ["data", "plans", "state"]) {
        mkdirSync(join(root, ".obsel", directory), { recursive: true });
        writeFileSync(join(root, ".obsel", directory, "leftover.json"), "{}\n");
      }

      const { code } = callCommand(
        `raise SystemExit(run.cmd_reset(args, Path(${JSON.stringify(root)})))`,
      );

      expect(code).toBe(0);
      expect(existsSync(join(root, ".obsel", "plans", "leftover.json"))).toBe(false);
      expect(existsSync(join(root, ".obsel", "state", "leftover.json"))).toBe(false);
      // `data` goes too, and then the seed is written back: every agent reads from
      // `raw_orders`, and nothing in the swarm produces it.
      expect(existsSync(join(root, ".obsel", "data", "leftover.json"))).toBe(false);
      expect(existsSync(join(root, ".obsel", "data", "raw_orders.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not delete the tasks themselves", async () => {
    // `resetSwarm` clears obsel's properties and the stale tag, and deliberately leaves
    // the DataJobs and their lineage edges in place: those edges are what the next take
    // re-runs against. A reset that removed them would turn a second demo take into a
    // re-registration.
    const root = mkdtempSync(join(tmpdir(), "obsel-reset-"));
    try {
      callCommand(`raise SystemExit(run.cmd_reset(args, Path(${JSON.stringify(root)})))`);

      const revenue = await readTask(taskUrn("build_revenue"));
      expect(revenue).not.toBeNull();
      expect(revenue?.reads).toContain(datasetUrn("clean_orders"));
      expect(revenue?.status).toBe("registered");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("repair on a clean board does nothing, and says so", () => {
  it("reads the real swarm, finds no flags, and exits 0 without spawning anything", () => {
    /*
     * The one path through `cmd_repair` that needs no model: the decision that
     * there is nothing to decide. It still crosses the real boundary — the
     * flagged set comes from a genuine swarm read, and the four demo tasks are
     * really there at `registered` after the reset above. The full path, redo
     * through real Codex sessions with flags coming off as they land, is a
     * live-model run and is exercised the way `change` is: by the demo's own
     * assertions, which exit non-zero when the board does not end clean.
     */
    const { code, output } = run(["repair", "--obsel-url", obselServer.url]);
    expect(output).toContain("nothing is flagged");
    expect(code).toBe(0);
  });
});
