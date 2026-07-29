/**
 * Grouping the coordinator's steps into the decisions they belong to.
 *
 * The cases that matter are the ragged ones. A trace is a bounded tail of a live
 * process, so the panel is routinely handed a pass with no beginning, a pass with
 * no end, or both at once, and presenting any of those as a whole decision would be
 * a claim obsel cannot support.
 */

import { describe, expect, it } from "vitest";

import { passSummary, passesOf } from "@/src/features/dashboard/passes";
import type { TraceEvent, TracePhase } from "@/src/server/coordinator/types";

let seq = 0;

// `message: string` is annotated, not inferred: defaulting it to `phase` without
// the annotation narrows it to TracePhase and rejects every real sentence.
function step(
  phase: TracePhase,
  message: string = phase,
  outcome: string | null = null,
): TraceEvent {
  seq += 1;
  return { seq, at: "2026-07-23T07:16:53.000Z", phase, message, outcome };
}

/**
 * One completion obsel judged and found nothing to do.
 *
 * The `read` message is the trigger, matching `engine.ts`: it emits
 * `` emit("read", `${label(finishing)} finished`, …) ``, so the step that opens a
 * pass already names what caused it.
 */
function quietPass(who = "Orders cleaner"): TraceEvent[] {
  return [
    step("read", `${who} finished`, "read 4 tasks from DataHub"),
    step("compare", "compared clean orders", "identical, nothing to do"),
    step("done", "nothing marked", "85 ms end to end"),
  ];
}

/** One completion that cascaded. */
function cascadePass(): TraceEvent[] {
  return [
    step("read", "Orders cleaner finished", "read 4 tasks from DataHub"),
    step("compare", "compared clean orders", "columns changed, values did not"),
    step("walk", "walked lineage from clean orders"),
    step("mark", "marked Daily revenue out of date"),
    step("done", "marked 3 out of date", "868 ms end to end"),
  ];
}

describe("passesOf", () => {
  it("splits on the read that opens each piece of coordination", () => {
    const passes = passesOf([...quietPass(), ...cascadePass()]);
    expect(passes).toHaveLength(2);
    expect(passes[0].header?.phase).toBe("read");
    expect(passes[0].events.map((e) => e.phase)).toEqual(["compare", "done"]);
    expect(passes[1].events.map((e) => e.phase)).toEqual(["compare", "walk", "mark", "done"]);
  });

  it("keeps every step, in the order the coordinator emitted it", () => {
    const events = [...quietPass(), ...cascadePass()];
    const grouped = passesOf(events).flatMap((pass) =>
      pass.header === null ? pass.events : [pass.header, ...pass.events],
    );
    expect(grouped.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
  });

  it("heads a pass with the completion that triggered it, not with its conclusion", () => {
    // A heading carrying the conclusion would print "marked 3 out of date"
    // immediately above the step that says exactly that.
    const [pass] = passesOf(cascadePass());
    expect(pass.header?.message).toBe("Orders cleaner finished");
    expect(pass.events.some((e) => e.message === "marked 3 out of date")).toBe(true);
    expect(pass.header?.message).not.toBe("marked 3 out of date");
  });

  it("carries what obsel read as the heading's detail", () => {
    expect(passesOf(quietPass())[0].header?.outcome).toBe("read 4 tasks from DataHub");
  });

  it("gives a pass in flight its heading and only the steps so far", () => {
    // Coordination still running. It must not be presented as having concluded, and
    // with the heading being the trigger rather than the verdict, it cannot be.
    const [pass] = passesOf(cascadePass().slice(0, 3));
    expect(pass.header?.message).toBe("Orders cleaner finished");
    expect(pass.events.map((e) => e.phase)).toEqual(["compare", "walk"]);
    expect(pass.events.some((e) => e.phase === "done")).toBe(false);
  });

  it("leaves a leading fragment headerless rather than inventing a decision for it", () => {
    // The buffer holds a bounded tail, so its oldest steps can be the middle of a
    // pass whose `read` has already been dropped. Those steps are real and are
    // shown; what they must not get is a heading presenting them as whole.
    const passes = passesOf([step("mark", "marked Table docs out of date"), ...quietPass()]);
    expect(passes).toHaveLength(2);
    expect(passes[0].header).toBeNull();
    expect(passes[0].events).toHaveLength(1);
    expect(passes[1].header).not.toBeNull();
  });

  it("gathers a whole leading run of non-read steps into the one fragment", () => {
    const passes = passesOf([step("write"), step("write"), ...quietPass()]);
    expect(passes).toHaveLength(2);
    expect(passes[0].header).toBeNull();
    expect(passes[0].events).toHaveLength(2);
  });

  it("keeps a write emitted after a decision in that decision's group", () => {
    // `started X` lands between decisions, and this is a timeline: the write did
    // happen after that decision. Giving bookkeeping its own heading would mean
    // inventing a label for steps that already describe themselves.
    const passes = passesOf([...quietPass(), step("write", "started Daily revenue")]);
    expect(passes).toHaveLength(1);
    expect(passes[0].events.map((e) => e.message)).toContain("started Daily revenue");
  });

  it("returns nothing for no steps", () => {
    expect(passesOf([])).toEqual([]);
  });

  it("keys a pass on a sequence number rather than a position", () => {
    // The panel re-renders once a second on a list that grows from the end. Keying
    // on an index would make React reuse a row for a different step.
    const passes = passesOf([...quietPass(), ...cascadePass()]);
    expect(passes[0].key).toBe(passes[0].header?.seq);
    expect(new Set(passes.map((p) => p.key)).size).toBe(passes.length);
  });
});

describe("passSummary", () => {
  it("counts decisions, which is the unit that means something", () => {
    expect(passSummary(passesOf([...quietPass(), ...cascadePass()]))).toBe("2 decisions, 8 steps");
  });

  it("counts the heading as a step, because it is one", () => {
    // The `read` is a step obsel took. Rendering it as a heading is a presentation
    // choice, and a count that dropped it would understate the trace.
    expect(passSummary(passesOf(quietPass()))).toBe("1 decision, 3 steps");
  });

  it("counts steps when it holds only a fragment, since there is no whole decision", () => {
    expect(passSummary(passesOf([step("write"), step("write")]))).toBe("2 steps");
    expect(passSummary(passesOf([step("write")]))).toBe("1 step");
  });

  it("promises nothing the panel cannot show", () => {
    // The header used to read `last 8 of 25` above a list sliced to eight, so 17 of
    // the steps it counted were not in the DOM and scrolling could never reach them.
    // Every step counted here is rendered.
    const events = [...quietPass(), ...quietPass("Daily revenue"), ...cascadePass()];
    const rendered = passesOf(events).reduce(
      (n, pass) => n + pass.events.length + (pass.header === null ? 0 : 1),
      0,
    );
    expect(passSummary(passesOf(events))).toContain(`${rendered} steps`);
    expect(rendered).toBe(events.length);
  });

  it("says idle rather than zero of anything", () => {
    expect(passSummary([])).toBe("idle");
  });
});
