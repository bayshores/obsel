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
 * Colour comes from `nodeTone(status, hasMark)` and nowhere else, which is the
 * invariant `tone.ts` documents: amber fill means the work is out of date, and
 * means nothing else. These components choose no colours of their own.
 */

import { Handle, Position } from "@xyflow/react";

import { datasetTitle, taskTitle } from "./naming";
import { STALE, STATUS_WORD, nodeTone } from "./tone";
import type { ColumnChange, TaskRecord } from "@/src/server/coordinator/types";

import styles from "./nodes.module.css";

/** What a task box is handed. */
export interface TaskNodeData {
  task: TaskRecord;
  /** True for the task that produced the output that changed. */
  isCause: boolean;
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
  const { task, isCause } = data;
  const tone = nodeTone(task.status, task.stale !== null);
  const hops = task.stale?.hops ?? null;

  return (
    <div
      className={styles.task}
      style={{
        // The status bar down the left edge. This is the amber.
        borderLeftColor: tone.fill,
        // An outline only when a mark is attached to work that is not itself
        // stale, which is the re-run case tone.ts explains.
        outline: tone.outline !== null ? `1px solid ${tone.outline}` : undefined,
        borderTopColor: isCause ? tone.fill : undefined,
      }}
    >
      <Ports />
      <span className={styles.taskName}>{taskTitle(task)}</span>
      <span className={styles.taskStatus} style={{ color: tone.fill }}>
        {STATUS_WORD[task.status]}
        {hops !== null && ` · ${hops} ${hops === 1 ? "hop" : "hops"}`}
      </span>
    </div>
  );
}

export function DataNode({ data }: { data: DataNodeData }) {
  const { urn, isOrigin, columns, external } = data;

  return (
    <div
      className={styles.data}
      style={{ borderColor: isOrigin ? STALE : undefined }}
      data-origin={isOrigin ? "true" : undefined}
    >
      <Ports />
      <span className={styles.dataName}>{datasetTitle(urn)}</span>

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
      {isOrigin && columns !== null ? (
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
        isOrigin && <span className={styles.changed}>changed</span>
      )}

      {/* Only on a table nothing in the swarm writes. Silence elsewhere: the
          absence of a note is not a claim, but an empty label would be. */}
      {external && !isOrigin && <span className={styles.external}>from outside</span>}
    </div>
  );
}
