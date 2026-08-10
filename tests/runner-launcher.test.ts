import { describe, expect, it } from "vitest";

import { LOG_MAX_LINE_CHARS, appendBounded, refusal, splitLines } from "@/src/server/runner/steps";

describe("splitLines", () => {
  it("carries a partial line across chunk boundaries instead of logging halves", () => {
    const first = splitLines("", "checking clean_or");
    expect(first.lines).toEqual([]);
    expect(first.rest).toBe("checking clean_or");

    const second = splitLines(first.rest, "ders\nnext line\n");
    expect(second.lines).toEqual(["checking clean_orders", "next line"]);
    expect(second.rest).toBe("");
  });

  it("strips a trailing carriage return so Windows-style output reads clean", () => {
    expect(splitLines("", "done\r\n").lines).toEqual(["done"]);
  });

  it("keeps an empty printed line — blank lines are part of the CLI's own formatting", () => {
    expect(splitLines("", "a\n\nb\n").lines).toEqual(["a", "", "b"]);
  });

  it("bounds a pathological single line rather than holding it whole", () => {
    const long = "x".repeat(LOG_MAX_LINE_CHARS * 2);
    const split = splitLines("", `${long}\n`);
    expect(split.lines[0]).toHaveLength(LOG_MAX_LINE_CHARS);
  });
});

describe("appendBounded", () => {
  it("keeps the newest lines when the cap is exceeded", () => {
    const log = appendBounded(["1", "2", "3"], ["4", "5"], 4);
    expect(log).toEqual(["2", "3", "4", "5"]);
  });

  it("returns the same array untouched when nothing is appended", () => {
    const before = ["1"];
    expect(appendBounded(before, [], 4)).toBe(before);
  });

  it("does not mutate its input — the activity route may be serializing the old one", () => {
    const before = ["1", "2"];
    appendBounded(before, ["3"], 2);
    expect(before).toEqual(["1", "2"]);
  });
});

describe("refusal", () => {
  const running = { step: "run" as const, startedAt: "2026-07-22T10:00:00.000Z" };

  it("refuses a second step while one runs, naming the one that is live", () => {
    const refused = refusal(running, true);
    expect(refused?.status).toBe(409);
    expect(refused?.error).toContain("run");
  });

  it("refuses without a venv and hands over the exact commands", () => {
    const refused = refusal(null, false);
    expect(refused?.status).toBe(409);
    expect(refused?.fix).toContain("python3 -m venv agents/.venv");
  });

  it("the busy refusal wins over the venv one — one problem at a time", () => {
    const refused = refusal(running, false);
    expect(refused?.error).toContain("already running");
  });

  it("permits a launch when idle and the venv exists", () => {
    expect(refusal(null, true)).toBeNull();
  });
});
