/**
 * A task DataHub has been told is gone, against a real DataHub that was really told.
 *
 * This exists because of what happened on 2026-07-28. A `clean_trips` DataJob that a
 * launcher bug had registered onto the demo flow was soft-deleted with the DataHub CLI.
 * DataHub accepted it and hid the entity in its own UI. obsel went on drawing it and
 * counting it, so the board read "4 of 5 agents finished" and could not reach the
 * settled stage at all, whatever anybody did to it.
 *
 * The reason is worth keeping next to the test: a soft delete writes a `status` aspect
 * and nothing else. The `IsPartOf` edge stays, so `GET /relationships` still lists the
 * task, and `batchGet` still returns it. Nothing about the swarm read failed. obsel was
 * simply reporting a swarm DataHub no longer agreed it had.
 *
 * Nothing here is stood in for. The soft delete is the real `status` aspect written to
 * the real GMS, which is exactly what `datahub delete --soft` writes, and it is undone
 * in the same way, so the suite leaves the flow as it found it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GMS, requireDataHub } from "./reachable";

const { readSnapshot } = await import("@/src/server/datahub/client");
const { registerTask } = await import("@/src/server/coordinator/engine");
const { taskUrn } = await import("@/src/server/datahub/urns");

/**
 * Registered once and never deleted, like every other task this suite makes.
 * Registration is permanent by design, so the name is this file's own.
 */
const NAME = "removed_probe";

/** What `datahub delete --soft` writes, and what undoing it writes. */
async function setRemoved(urn: string, removed: boolean): Promise<void> {
  // The same call `client.ts` writes every other aspect with: POST the entity
  // collection with `async=false`, so GMS applies it before answering and the
  // next read sees it. The per-URN path answers 405 to a write.
  const response = await fetch(`${GMS}/openapi/v3/entity/datajob?async=false`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ urn, status: { value: { removed } } }]),
  });
  if (!response.ok) {
    throw new Error(
      `writing status.removed=${removed} to ${urn} answered ${response.status}: ` +
        `${(await response.text()).slice(0, 200)}`,
    );
  }
}

function names(tasks: { name: string }[]): string[] {
  return tasks.map((task) => task.name);
}

describe("a task DataHub has been told is gone", () => {
  const urn = taskUrn(NAME);

  beforeAll(async () => {
    await requireDataHub();
    await registerTask(NAME, ["raw_orders"], ["removed_probe_out"], undefined, "Removed probe");
    // Live before anything is asserted about removing it, or the test proves nothing.
    await setRemoved(urn, false);
  });

  afterAll(async () => {
    // Left exactly as found: present and not removed.
    await setRemoved(urn, false);
  });

  it("is on the board while DataHub still has it", async () => {
    const snapshot = await readSnapshot();
    expect(names(snapshot.tasks)).toContain(NAME);
  });

  it("leaves the flow's edge alone, which is why obsel could not see the delete", async () => {
    await setRemoved(urn, true);

    // The half that made this invisible: the graph still lists it, and the aspect
    // store still returns it. Measured rather than asserted from memory, because
    // it is the whole reason a status-blind read reported the task as present.
    const edges = await fetch(
      `${GMS}/relationships?urn=${encodeURIComponent(
        `urn:li:dataFlow:(obsel,${process.env.OBSEL_FLOW_ID ?? "orders_pipeline"},prod)`,
      )}&direction=INCOMING&types=IsPartOf&start=0&count=200`,
    ).then((response) => response.json() as Promise<{ relationships: { entity: string }[] }>);
    expect(edges.relationships.map((edge) => edge.entity)).toContain(urn);

    const returned = await fetch(`${GMS}/openapi/v3/entity/datajob/batchGet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ urn }]),
    }).then((response) => response.json() as Promise<{ urn: string }[]>);
    expect(returned.map((entity) => entity.urn)).toContain(urn);
  });

  it("is off the board once it is removed", async () => {
    await setRemoved(urn, true);
    const snapshot = await readSnapshot();
    expect(names(snapshot.tasks)).not.toContain(NAME);
  });

  it("does not take the rest of the swarm with it", async () => {
    // The guard that fires when the graph lists a task the aspect store does not
    // return is about a genuinely missing entity, and a soft delete is not that.
    // Before the filter was ordered after that check, this read threw instead.
    await setRemoved(urn, true);
    const snapshot = await readSnapshot();
    expect(snapshot.tasks.length).toBeGreaterThan(0);
    expect(snapshot.flow).toContain("dataFlow");
  });

  it("comes back when the delete is undone, because nothing here is stored", async () => {
    await setRemoved(urn, true);
    expect(names((await readSnapshot()).tasks)).not.toContain(NAME);

    await setRemoved(urn, false);
    expect(names((await readSnapshot()).tasks)).toContain(NAME);
  });

  it("reads removed:false as present, not as a mark that exists", async () => {
    // `status` is absent on a task nobody has touched and present with
    // `removed: false` on one that has been restored. A check on the aspect's
    // presence would call the second one deleted forever.
    await setRemoved(urn, false);
    const snapshot = await readSnapshot();
    expect(names(snapshot.tasks)).toContain(NAME);
  });
});
