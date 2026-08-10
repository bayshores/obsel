"use client";

/**
 * The two kinds of box on the graph, as HTML.
 *
 * They used to be `<text>` elements positioned by hand inside one big SVG, with
 * their widths reserved by counting characters. Real elements instead, so the
 * browser does the text layout it is good at, and so the one node that matters
 * most can carry a two-line column diff without anything being measured in
 * advance.
 *
 * Color comes from `nodeTone(status, hasMark)` and nowhere else, which is the
 * invariant `tone.ts` documents: amber fill means the work is out of date, and
 * means nothing else. These components choose no colors of their own.
 */

import { Handle, Position } from "@xyflow/react";

import { coverageTone, stateWord } from "../erasure/coverage-view";
import { datasetTitle, taskTitle } from "../naming";
import { MUTE, STALE, STATUS_WORD, nodeTone } from "../tone";
import type { ErasureState } from "@/src/server/coordinator/erasure";
import type { ColumnChange, TaskRecord } from "@/src/server/coordinator/types";

import styles from "./nodes.module.css";

/** What a task box is handed. */
export interface TaskNodeData {
  task: TaskRecord;
  /** True for the task that produced the output that changed. */
  isCause: boolean;
  /**
   * Which cascade is standing, as one string, or nothing on a calm board.
   *
   * Used only as a React `key`, and that is the whole mechanism behind the
   * ripple: a new cascade is a new key, a new key remounts the overlay element
   * below, and a freshly mounted element runs its one-shot CSS animation from
   * the beginning. Rebuilds that are not a new cascade carry the same string, so
   * nothing remounts and nothing replays.
   *
   * It is never read for a color or a state. `nodeTone` decides what this box
   * claims, on its own, from the record.
   */
  ripple: string | null;
  /**
   * True when the board is being read as an erasure report.
   *
   * An agent then carries no color and no status word, and that is a statement
   * rather than a simplification: coverage is a property of an asset, obsel has
   * nothing to say about an agent's own erasure state, and the amber that says
   * "this finished work went out of date" is answering the other question
   * entirely. Two answers painted on one picture leave a reader unable to tell
   * which one a color belongs to, so this board answers one.
   */
  neutral: boolean;
  [key: string]: unknown;
}

/** What a dataset box is handed. */
export interface DataNodeData {
  urn: string;
  /** True for the dataset whose fingerprint moved. */
  isOrigin: boolean;
  /** Which columns moved, when this is the origin and obsel recorded them. */
  columns: ColumnChange | null;
  /** No task in the swarm writes this, so obsel has no fingerprint for it. */
  external: boolean;
  /**
   * What an erasure report says about this table, when the board is being read
   * that way, and `undefined` when it is not.
   *
   * `null` and `undefined` mean different things here and the difference is the
   * point. `undefined` is "the board is not in erasure mode". `null` is "it is,
   * and this table is not in the report" — the walk did not reach it. Rendering
   * the second as a state would turn an asset nobody looked at into an asset
   * somebody cleared, which is the exact substitution the whole erasure design
   * exists to prevent.
   *
   * `"withheld"` is the third: the board is in erasure mode and the report could
   * not be read at all. The box then carries no color and no word, because
   * "not reached" would be a claim about a walk that did not happen. The canvas
   * says why, once, rather than every box saying it.
   */
  coverage?: ErasureState | null | "withheld";
  [key: string]: unknown;
}

/**
 * Ports on the left and right, hidden.
 *
 * React Flow needs them to anchor an edge, but a visible dot on every side of
 * every box is six pieces of furniture per node that mean nothing to a reader.
 * The arrowheads already say which way the data flows.
 */
function Ports() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        className={styles.port}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        className={styles.port}
        isConnectable={false}
      />
    </>
  );
}

export function TaskNode({ data }: { data: TaskNodeData }) {
  const { task, isCause, ripple, neutral } = data;
  const tone = nodeTone(task.status, task.stale !== null);
  const hops = task.stale?.hops ?? null;

  return (
    <div
      className={styles.task}
      style={
        neutral
          ? { borderLeftColor: MUTE }
          : {
              // The status bar down the left edge. This is the amber.
              borderLeftColor: tone.fill,
              // An outline only when a mark is attached to work that is not
              // itself stale, which is the re-run case tone.ts explains.
              outline: tone.outline !== null ? `1px solid ${tone.outline}` : undefined,
              borderTopColor: isCause ? tone.fill : undefined,
            }
      }
    >
      <Ports />
      {/*
        The ripple: one flare, at the moment this box is reached.

        It is a sibling element rather than an animation on the box, and that is
        deliberate rather than tidy. The box's color is `nodeTone`'s claim about
        what is true, and `tone.ts` states the rule this obeys: a dropped frame or
        an interrupted transition must not be able to change what the board says.
        A separate element cannot. It flares and it is gone; the amber underneath
        it was already correct before it started and stays correct if it never
        runs at all.

        The delay is the mark's own hop count, so the flare travels outward in the
        order obsel actually walked. The hops are read off the mark rather than
        re-derived from the graph, which is the same rule `cascade.ts` keeps for
        deciding which path is lit at all.
      */}
      {!neutral && ripple !== null && task.stale !== null && (
        <span
          key={ripple}
          className={styles.flare}
          style={{ "--hop": hops ?? 1 } as React.CSSProperties}
          aria-hidden="true"
        />
      )}
      <span className={styles.taskName}>{taskTitle(task)}</span>
      {!neutral && (
        <span className={styles.taskStatus} style={{ color: tone.fill }}>
          {STATUS_WORD[task.status]}
          {hops !== null && ` · ${hops} ${hops === 1 ? "hop" : "hops"}`}
        </span>
      )}
    </div>
  );
}

export function DataNode({ data }: { data: DataNodeData }) {
  const { urn, isOrigin, columns, external, coverage } = data;
  const reading = coverage !== undefined;
  // The erasure board with nothing read: no color, no state word, and no
  // staleness treatment either.
  const withheld = coverage === "withheld";
  const state = coverage === undefined || withheld ? null : coverage;

  return (
    <div
      className={styles.data}
      /*
       * In erasure mode the box carries a coverage state and nothing else.
       *
       * The origin outline goes with it, deliberately. That outline is amber and
       * amber on this board means exactly one thing: finished work went out of
       * date. An erasure gap is not that, nothing is out of date, and putting
       * obsel's one reserved signal on a second condition would break the rule
       * `tone.ts` keeps on the other half of the same screen.
       */
      style={
        reading
          ? state === null
            ? undefined
            : { borderLeft: `3px solid ${coverageTone(state).fill}` }
          : { borderColor: isOrigin ? STALE : undefined }
      }
      data-origin={!reading && isOrigin ? "true" : undefined}
      data-coverage={reading && !withheld ? (state ?? "not-reached") : undefined}
    >
      <Ports />
      <span className={styles.dataName}>{datasetTitle(urn)}</span>

      {/*
        What the report says about this table, in the report's own words.

        A table the walk did not reach says so rather than showing nothing: an
        absent claim and a clean one look identical on a board, and only one of
        them is true here.
      */}
      {reading && !withheld && (
        <span
          className={styles.coverage}
          style={{
            color: state === null ? "var(--mm-cream-mute)" : coverageTone(state).fill,
          }}
        >
          {state === null ? "not reached" : stateWord(state)}
        </span>
      )}

      {/*
        The whole reason this rebuild happened.

        This slot used to hold `s f7b62a66` and `c 539b5097`: a sha256 pair, on
        every dataset, which is the literal evidence obsel decides on and is
        unreadable to a person. Ten of them were on screen and not one explained
        anything. A reader who sees `order_total` leave and `order_total_usd`
        arrive understands obsel's entire premise without being told it.

        Rendered as a diff rather than as "renamed", because a column leaving and
        another arriving is indistinguishable from a drop plus an unrelated
        addition. The reader draws the obvious conclusion; obsel does not assert
        it. The fingerprints are still shown, labelled, when a node is opened.
      */}
      {!reading && isOrigin && columns !== null ? (
        <span className={styles.diff}>
          {columns.removed.map((column) => (
            <span key={`out-${column}`} className={styles.columnOut}>
              {`- ${column}`}
            </span>
          ))}
          {columns.added.map((column) => (
            <span key={`in-${column}`} className={styles.columnIn}>
              {`+ ${column}`}
            </span>
          ))}
        </span>
      ) : (
        !reading && isOrigin && <span className={styles.changed}>changed</span>
      )}

      {/* Only on a table nothing in the swarm writes. Silence elsewhere: the
          absence of a note is not a claim, but an empty label would be. */}
      {!reading && external && !isOrigin && <span className={styles.external}>from outside</span>}
    </div>
  );
}
