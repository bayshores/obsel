/**
 * `agents/run.py`'s commands that need no model, against a real obsel and a real DataHub.
 *
 * `run.py` is the demo driver. Five of its seven commands (`run`, `rerun-same`, `change`,
 * `repair`, and `setup`) reach a live Codex session or DataHub's vocabulary registration,
 * and are covered elsewhere: the guards those commands print are checked offline by
 * `python -m agents.run self-check`, and the Codex invocation itself by
 * `runners.live.test.ts`. `register` and `reset` are the two that talk only to obsel, so
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

import { API_TOKEN, startObsel } from "./obsel-server";
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
    env: { ...process.env, OBSEL_FLOW_ID: FLOW_ID, OBSEL_API_TOKEN: API_TOKEN, ...env },
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
    env: { ...process.env, OBSEL_FLOW_ID: FLOW_ID, OBSEL_API_TOKEN: API_TOKEN },
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

describe("a run declares whatever obsel has no record of, and nothing else", () => {
  /*
   * The board is a flow of its own, because "obsel has no record of these tasks"
   * cannot be produced on a flow the suite above has already registered into,
   * and obsel deletes nothing to get back there. A fresh `OBSEL_FLOW_ID` is a
   * genuinely empty board rather than a simulation of one.
   *
   * `_register_missing` directly rather than `cmd_run`: the registration is the
   * subject, and `cmd_run` would spawn four real agent sessions to reach the
   * same three assertions. Whole runs are covered by `codex.live.test.ts`.
   */
  const MERGE_FLOW = "obsel_integration_run_merge";
  const MERGE_PORT = 3097;
  let empty: ObselServer;

  /*
   * Built here rather than with `taskUrn`, which closes over the `OBSEL_FLOW_ID`
   * this module was imported with. That is the demo-adjacent integration flow,
   * not this describe's own, and asking it for a urn would quietly read the
   * wrong board — the exact confusion the mismatch test below exists for.
   */
  function mergeTaskUrn(name: string): string {
    return `urn:li:dataJob:(urn:li:dataFlow:(obsel,${MERGE_FLOW},prod),${name})`;
  }

  function registerMissing(): Ran {
    const script = [
      "import argparse",
      "from agents import run_demo",
      `args = argparse.Namespace(obsel_url=${JSON.stringify(empty.url)}, capture=None)`,
      "raise SystemExit(run_demo._register_missing(args))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, OBSEL_FLOW_ID: MERGE_FLOW, OBSEL_API_TOKEN: API_TOKEN },
    });
    return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  beforeAll(async () => {
    empty = await startObsel(MERGE_PORT, MERGE_FLOW);
    return async () => {
      await empty.stop();
    };
  }, 120_000);

  /*
   * Asserted against the board as it is, never against an assumed empty one.
   *
   * The first version of these tests assumed this flow held nothing, which was
   * true exactly once: registration is permanent, obsel deletes nothing, and the
   * run that proved the behavior is the run that made the assumption false. Both
   * tests then failed on the next full-suite run — the same trap
   * `engine.live.test.ts` records having been caught by, arriving here.
   *
   * So each test reads what obsel holds, then asserts what the call did about it.
   * The property under test is the delta, which is what the code actually decides.
   */
  type DemoTask = (typeof DEMO_TASKS)[number];

  async function absent(): Promise<DemoTask[]> {
    const held = await Promise.all(
      DEMO_TASKS.map(async (name) => ((await readTask(mergeTaskUrn(name))) === null ? name : null)),
    );
    return held.filter((name): name is DemoTask => name !== null);
  }

  it("declares exactly the tasks obsel has no record of, and reads them back", async () => {
    const missing = await absent();
    const { code, output } = registerMissing();

    expect(code).toBe(0);
    if (missing.length > 0) {
      expect(output).toContain(`obsel had no record of ${missing.length} of the 4 tasks`);
      for (const name of missing) expect(output).toContain(name);
    } else {
      // Nothing absent, so nothing said. The quiet case is the one that protects
      // a board that has already run.
      expect(output.trim()).toBe("");
    }

    // Either way, all four are on the board afterwards, read out of DataHub
    // rather than trusted from the printed line.
    for (const name of DEMO_TASKS) {
      expect(await readTask(mergeTaskUrn(name)), `${name} must be on the board`).not.toBeNull();
    }
  }, 180_000);

  it("declares nothing once every task is on the board, and says nothing", async () => {
    // Runs after the test above, so the board is full whatever state it started in.
    expect(await absent()).toEqual([]);

    const { code, output } = registerMissing();
    expect(code).toBe(0);
    expect(output).not.toContain("obsel had no record of");
    expect(output.trim()).toBe("");
  }, 120_000);

  it("leaves a task obsel already holds exactly as it was", async () => {
    /*
     * The reason the set is computed rather than blindly re-registered: a
     * re-declaration upserts the DataJob with `status: registered`, so a
     * registration covering a task obsel already holds would discard the state a
     * run had put on it. Announced-and-running is the cheapest real state to
     * prove that with, through obsel's own API.
     *
     * Abandoned first, and that is what makes this repeatable rather than a test
     * that passes once: a previous run of this file left the task at `running`,
     * and `startTask` refuses a task that is already running. Abandoning puts it
     * back to whatever it held before it announced, which is the state this test
     * needs to start from and is exactly what that route is for.
     */
    const urn = mergeTaskUrn("clean_orders");
    const post = async (path: string) =>
      await fetch(`${empty.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ taskUrn: urn }),
      });

    // Not asserted: a task that was not running is left alone and reported
    // untouched, which is a success either way.
    await post("/api/tasks/abandon");

    const answer = await post("/api/tasks/start");
    expect(answer.ok).toBe(true);

    const announced = await readTask(urn);
    expect(announced?.status).toBe("running");
    expect(announced?.startedAt).not.toBeNull();

    expect(registerMissing().code).toBe(0);

    const after = await readTask(urn);
    expect(after?.status).toBe("running");
    expect(after?.startedAt).toBe(announced?.startedAt);

    // Left as it was found, so a later run of this file starts from a task that
    // is not mid-announcement.
    await post("/api/tasks/abandon");
  }, 180_000);
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
