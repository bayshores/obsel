"use client";

/**
 * obsel's read of the lineage graph, drawn.
 *
 * Every position on screen comes from `graph/layout.ts`, which never sees a
 * task's status — so nothing moves when three tasks flip amber. Every colour
 * comes from `nodeTone`, which takes exactly `(status, hasMark)` and reads no
 * timer. Between them, the animation layer is left able to write only
 * `stroke-dashoffset` and caption opacity: it is structurally incapable of
 * changing what the cockpit claims is true, so a dropped frame or an
 * interrupted transition cannot produce a wrong answer.
 */

import { cascadeEdges, layoutGraph, reserveFor, shortName } from "./graph/layout";
import type { Box, GraphEdge, GraphLayout } from "./graph/layout";
import { DATA_BOX, TASK_BOX } from "./graph/layout";
import { clockTime, currentChange } from "./timing";
import { LONGEST_STATUS_WORD, ROSE, STALE, STATUS_WORD, nodeTone } from "./tone";
import type { TaskRecord } from "@/src/server/coordinator/types";

import styles from "./lineage.module.css";

/** First eight characters of a fingerprint — enough to see one differ. */
function hex8(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, 8);
}

function subtitleOf(task: TaskRecord): string {
  const word = STATUS_WORD[task.status];
  if (task.stale === null) return word;
  const { hops } = task.stale;
  return `${word}  · ${hops} ${hops === 1 ? "hop" : "hops"}`;
}

/**
 * The task box's third line, LABELLED.
 *
 * The graph shows when the task last finished; the ledger's right-hand column
 * shows when a mark was applied. For a stale task those are different instants,
 * and both were rendered as a bare `17:23:52` in the same monospace face — two
 * unlabelled numbers that disagreed with each other for no visible reason.
 * Deliberately the same formatter as the ledger; see clockTime's own note.
 */
const clockOf = (task: TaskRecord): string =>
  task.finishedAt === null ? "not finished yet" : `finished ${clockTime(task.finishedAt)}`;

function pathFor(edge: GraphEdge, graph: GraphLayout): string {
  const a = graph.boxes[edge.from];
  const b = graph.boxes[edge.to];
  if (edge.kind === "write") {
    // A task and the dataset it writes share a column, one above the other.
    const x = a.x + a.w / 2;
    return `M ${x} ${a.y + a.h} L ${x} ${b.y}`;
  }
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;

  /*
   * An edge that passes over a box takes the clear lane below everything
   * instead of ploughing through the names and status text in between.
   * `detourY` is only non-null when the graph actually contains such an edge,
   * and this edge only uses it when a box really is in its way.
   */
  if (graph.detourY !== null && crossesABox(a, b, graph)) {
    const lane = graph.detourY;
    return `M ${x1} ${y1} C ${x1 + 24} ${y1}, ${x1 + 24} ${lane}, ${x1 + 48} ${lane} L ${x2 - 48} ${lane} C ${x2 - 24} ${lane}, ${x2 - 24} ${y2}, ${x2} ${y2}`;
  }

  if (Math.abs(y1 - y2) < 0.5) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

/** Is a third box sitting in the corridor this edge would take? */
function crossesABox(a: Box, b: Box, graph: GraphLayout): boolean {
  const left = a.x + a.w;
  const right = b.x;
  if (right <= left) return false;
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return Object.values(graph.boxes).some(
    (box) =>
      box !== a &&
      box !== b &&
      box.x < right &&
      box.x + box.w > left &&
      box.y < bottom &&
      box.y + box.h > top,
  );
}

export function Lineage({ tasks }: { tasks: TaskRecord[] }) {
  const graph = layoutGraph(tasks, reserveFor(tasks, LONGEST_STATUS_WORD));

  // The same rule the stat ribbon uses. Picking `marks[0]` here instead — the
  // first in dependency order — made the graph caption one dataset while the
  // ribbon timed a different one, as soon as two cascades coexisted.
  const origin = currentChange(tasks);
  const originDataset = origin?.causedBy ?? null;
  const causeTaskUrn = origin?.causedByTask ?? null;
  const lit = cascadeEdges(tasks, originDataset, causeTaskUrn);

  /* The caption sits above the whole group, never in the 16px seam between a
     task and the dataset it writes. */
  const groupTop = (datasetUrn: string): number => {
    const writer = graph.producerOf[datasetUrn];
    const box =
      writer === undefined ? graph.boxes[`d:${datasetUrn}`] : graph.boxes[`t:${writer.urn}`];
    return box === undefined ? 0 : box.y;
  };

  const datasetKeys = Object.keys(graph.boxes).filter((key) => key.startsWith("d:"));

  return (
    <svg
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      className={styles.svg}
      role="img"
      aria-label="Lineage graph: each agent task, the data it reads and writes, and the path a change travelled."
    >
      <defs>
        <marker
          id="obsel-tip-rest"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 5.5 3 L 0 6 z" fill="var(--mm-rose-line)" />
        </marker>
        <marker
          id="obsel-tip-lit"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M 0 0 L 5.5 3 L 0 6 z" fill="var(--obsel-stale)" />
        </marker>
      </defs>

      {/* Resting edges. Never removed — the lit stroke draws on top of them, so
          the graph's shape is legible whether or not anything is stale. */}
      {graph.edges.map((edge) => (
        <path
          key={edge.id}
          d={pathFor(edge, graph)}
          fill="none"
          stroke="var(--mm-rose-line)"
          strokeWidth="1"
          markerEnd="url(#obsel-tip-rest)"
        />
      ))}

      {/* The cascade. Ordered by hop, staggered min((hop-1) × 180, 400) ms —
          every value on mmux's ladder, and Math.min makes the ceiling a
          property of the code rather than a fact about a four-task graph. */}
      {graph.edges
        .filter((edge) => lit[edge.id] !== undefined)
        .map((edge) => (
          <path
            key={`lit-${edge.id}`}
            className={styles.edgeCascade}
            style={{ "--hop": lit[edge.id] } as React.CSSProperties}
            d={pathFor(edge, graph)}
            fill="none"
            stroke="var(--obsel-stale)"
            strokeWidth="2"
            // Renormalises this path's length to 1 so the dash animation in
            // lineage.module.css is a fraction of its own length rather than a
            // fixed count of user units. See the note on .edgeCascade.
            pathLength={1}
            markerEnd="url(#obsel-tip-lit)"
          />
        ))}

      {tasks.map((task) => {
        const box = graph.boxes[`t:${task.urn}`];
        if (box === undefined) return null;
        const tone = nodeTone(task.status, task.stale !== null);
        const isCause = causeTaskUrn === task.urn;
        const baseline = box.y + TASK_BOX.padY + 13;

        return (
          <g key={task.urn}>
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              fill="var(--mm-surface)"
              stroke={isCause ? ROSE : (tone.outline ?? "var(--mm-rose-line)")}
              strokeWidth={isCause || tone.outline !== null ? 2 : 1}
              className={isCause ? styles.cause : undefined}
            />
            {/* The status bar. This is the amber, and it is bound to status. */}
            <rect x={box.x} y={box.y} width="3" height={box.h} fill={tone.fill} />
            {/* Corner tick — instrument, not ornament: it marks which box a
                reading belongs to when two sit close together. */}
            <path
              d={`M ${box.x + box.w - 9} ${box.y + 1} L ${box.x + box.w - 1} ${box.y + 1} L ${box.x + box.w - 1} ${box.y + 9}`}
              fill="none"
              stroke={isCause ? ROSE : tone.fill}
              strokeWidth="1"
              opacity="0.75"
            />
            <text x={box.x + TASK_BOX.padX} y={baseline} className={styles.taskName}>
              {task.name}
            </text>
            <text
              x={box.x + TASK_BOX.padX}
              y={baseline + TASK_BOX.lineSub}
              fill={tone.fill}
              className={styles.taskStatus}
            >
              {subtitleOf(task)}
            </text>
            <text
              x={box.x + TASK_BOX.padX}
              y={baseline + TASK_BOX.lineSub * 2}
              className={styles.taskClock}
            >
              {clockOf(task)}
            </text>
          </g>
        );
      })}

      {datasetKeys.map((key) => {
        const datasetUrn = key.slice(2);
        const box = graph.boxes[key];
        const writer = graph.producerOf[datasetUrn];
        const print = writer === undefined ? undefined : writer.fingerprints[datasetUrn];
        const isOrigin = originDataset === datasetUrn;
        const line = (n: number): number => box.y + DATA_BOX.padY + 10 + DATA_BOX.line * n;

        return (
          <g key={key}>
            <rect
              x={box.x}
              y={box.y}
              width={box.w}
              height={box.h}
              fill="var(--mm-ink-2)"
              stroke={isOrigin ? STALE : "var(--mm-rose-line)"}
              strokeWidth={isOrigin ? 2 : 1}
            />
            <text x={box.x + DATA_BOX.padX} y={line(0)} className={styles.dataName}>
              {shortName(datasetUrn)}
            </text>

            {/* Both fingerprints, always. Which one moved is the entire answer,
                and it is only readable next to the one that did not.

                The highlight goes through `style`, not the `fill` attribute.
                `fill` is an SVG presentation attribute, which sits BELOW the
                stylesheet in the cascade, so `.print { fill: … }` silently won
                and the changed fingerprint rendered in the same grey as the
                unchanged one — the graph quietly withholding the one detail it
                exists to point at. */}
            {writer === undefined ? (
              <text x={box.x + DATA_BOX.padX} y={line(1)} className={styles.print}>
                external
              </text>
            ) : print === undefined ? (
              <text x={box.x + DATA_BOX.padX} y={line(1)} className={styles.print}>
                no print
              </text>
            ) : (
              <>
                <text
                  x={box.x + DATA_BOX.padX}
                  y={line(1)}
                  className={styles.print}
                  style={
                    isOrigin && origin !== null && origin.changeKind !== "content"
                      ? { fill: STALE }
                      : undefined
                  }
                >
                  {`s ${hex8(print.schema) ?? ""}`}
                </text>
                <text
                  x={box.x + DATA_BOX.padX}
                  y={line(2)}
                  className={styles.print}
                  style={
                    isOrigin && origin !== null && origin.changeKind !== "schema"
                      ? { fill: STALE }
                      : undefined
                  }
                >
                  {`c ${hex8(print.content) ?? ""}`}
                </text>
              </>
            )}

            {isOrigin && origin !== null && (
              <text
                x={box.x + box.w / 2}
                y={groupTop(datasetUrn) - 11}
                textAnchor="middle"
                fill={STALE}
                className={`${styles.caption} ${styles.originCaption}`}
              >
                {`changed · ${origin.changeKind}`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
