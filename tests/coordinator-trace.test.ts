/**
 * The buffer behind "what obsel is doing".
 *
 * The properties that matter are the ones that keep it from becoming state: it
 * is bounded, it hands out copies, and it cannot make the coordinator fail. The
 * last one is the reason this file exists — `emit` is called from inside
 * `coordinateCompletion`, between deciding a task is stale and writing the mark,
 * so a narration bug that threw would stop a mark from ever being written.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { createTraceBuffer } from "@/src/server/coordinator/trace-buffer";

/** The limit the server instance uses, so the bounding tests describe reality. */
const TRACE_LIMIT = 200;

let buffer = createTraceBuffer(TRACE_LIMIT);
let emit: typeof buffer.emit;
let read: typeof buffer.read;
let clear: typeof buffer.clear;

beforeEach(() => {
  buffer = createTraceBuffer(TRACE_LIMIT);
  ({ emit, read, clear } = buffer);
});

describe("emit and read", () => {
  it("keeps steps in the order they happened, oldest first", () => {
    emit("read", "first");
    emit("compare", "second");
    emit("mark", "third");

    expect(read().map((event) => event.message)).toEqual(["first", "second", "third"]);
  });

  it("records the phase and the outcome it was given", () => {
    emit("compare", "compared clean orders", "its columns changed; the values did not");

    const [event] = read();
    expect(event.phase).toBe("compare");
    expect(event.outcome).toBe("its columns changed; the values did not");
  });

  it("leaves the outcome null when none was given, rather than inventing an empty one", () => {
    emit("read", "read the swarm");

    expect(read()[0].outcome).toBeNull();
  });

  it("stamps each step with a timestamp and a monotonic sequence", () => {
    emit("read", "one");
    emit("read", "two");

    const [first, second] = read();
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(Number.isNaN(Date.parse(first.at))).toBe(false);
  });
});

describe("bounding", () => {
  it("keeps the newest steps once the limit is passed", () => {
    for (let i = 1; i <= TRACE_LIMIT + 25; i += 1) emit("read", `step ${i}`);

    const events = read();
    expect(events).toHaveLength(TRACE_LIMIT);
    // The oldest 25 are gone and the newest is still there.
    expect(events[0].message).toBe("step 26");
    expect(events[events.length - 1].message).toBe(`step ${TRACE_LIMIT + 25}`);
  });

  it("never grows without limit, however long a server lives", () => {
    for (let i = 0; i < TRACE_LIMIT * 3; i += 1) emit("write", "churn");

    expect(read().length).toBeLessThanOrEqual(TRACE_LIMIT);
  });
});

describe("clear", () => {
  it("drops every step, so a reset does not narrate the previous take", () => {
    emit("mark", "from the last run");
    clear();

    expect(read()).toEqual([]);
  });

  it("keeps counting sequence numbers across a clear", () => {
    emit("read", "before");
    const before = read()[0].seq;
    clear();
    emit("read", "after");

    // Reusing numbers would make a fresh step look like one the cockpit has
    // already rendered.
    expect(read()[0].seq).toBeGreaterThan(before);
  });
});

describe("isolation from the coordinator", () => {
  it("hands out a copy — a caller mutating the result cannot corrupt the buffer", () => {
    emit("read", "kept");

    const taken = read();
    taken.length = 0;
    taken.push({ seq: 999, at: "whenever", phase: "done", message: "injected", outcome: null });

    expect(read().map((event) => event.message)).toEqual(["kept"]);
  });

  it("returns nothing and throws nothing, so it can never fail a write it sits beside", () => {
    expect(() => emit("mark", "x".repeat(10_000), null)).not.toThrow();
    expect(emit("read", "returns undefined")).toBeUndefined();
  });
});
