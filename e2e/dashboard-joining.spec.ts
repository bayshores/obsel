import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { finishedStep } from "./fixtures/activity";
import { calm, cascaded, empty, justOne, visiting } from "./fixtures/swarm";
import { obselAlert, openDashboard, openTab } from "./fixtures/mount";

/**
 * Joining a board that is not the demo's own.
 *
 * An outside agent, a table typed in by hand, and a swarm of one. Every button
 * on these boards has to act on work that is genuinely on screen.
 */

/**
 * The door an outside agent joins through.
 *
 * These exist because of a specific failure: the panel's contents were correct
 * and complete, and were rendered as a closed 17px line above the graph, and the
 * person who wrote them did not know they were on the page. Every test here is
 * about being findable, which is the property that was missing. `joining.ts`'s
 * own unit tests cover which steps tick; none of that is repeated here.
 */
test.describe("bring your own agent", () => {
  const panel = (page: Page) => page.locator('[aria-label="Bring your own agent"]');

  /**
   * Open the board and then this panel's tab, which is how a reader reaches it.
   *
   * The panel is one of the panel's three tabs now rather than a row under the
   * graph. That does not weaken what this file is about: every test below is
   * about the panel being findable rather than a 17px line nobody noticed, and a
   * permanently visible 13px tab label is the answer to that, where a collapsed
   * disclosure was not.
   */
  const arrive = async (
    page: Page,
    ...args: Parameters<typeof openDashboard> extends [Page, ...infer R] ? R : never
  ) => {
    const handle = await openDashboard(page, ...args);
    await openTab(page, "your agent");
    return handle;
  };

  test("is a panel with a heading, not a line somebody has to notice", async ({ page }) => {
    await arrive(page, cascaded(), finishedStep());

    const heading = panel(page).getByRole("heading", { name: "bring your own agent" });
    await expect(heading).toBeVisible();

    // The measurement that motivated the work, kept as the assertion. The old
    // disclosure was 12px type in a 17px row. A heading below either number is
    // this regression coming back.
    const size = await heading.evaluate((node) => ({
      font: Number.parseFloat(getComputedStyle(node).fontSize),
      height: Math.round(node.getBoundingClientRect().height),
    }));
    expect(size.font, "the heading is back to disclosure type").toBeGreaterThan(12);
    expect(size.height, "the heading is back to a single thin row").toBeGreaterThan(17);
  });

  test("says nobody has joined, and keeps the steps folded, on obsel's own board", async ({
    page,
  }) => {
    // The state the board is in on camera. The heading is visible; the four
    // steps are not painted.
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText("how an agent joins")).toBeVisible();
    // The step rows, which are the prose the fold exists to hold back. In the
    // DOM, painted by nobody.
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
  });

  test("opens itself, and counts the steps, once somebody's agent is on the board", async ({
    page,
  }) => {
    await arrive(page, visiting(), finishedStep());

    // Three of four: registered, announced and reported have happened for the
    // visitor's own tasks, and no change has landed on their data yet.
    await expect(panel(page).getByText("3 of 4")).toBeVisible();
    await expect(panel(page).getByText("clean expenses", { exact: false }).first()).toBeVisible();

    const ticks = await panel(page).evaluate((node) =>
      [...node.querySelectorAll("li[data-done]")].map((li) => li.getAttribute("data-done")),
    );
    expect(ticks).toEqual(["true", "true", "true", "false"]);
  });

  test("does not count obsel's own demonstration as somebody having joined", async ({ page }) => {
    // The whole four-task demo, finished and flagged. None of it is the reader's
    // agent, so none of it is their progress, and a panel that ticked here would
    // be congratulating them on work they did not do.
    await arrive(page, cascaded(), finishedStep());
    await expect(panel(page).getByText("nobody has joined yet")).toBeVisible();
    await expect(panel(page).getByText(/\d of 4/)).toBeHidden();
  });

  test("hands over this machine's real command, not a placeholder path", async ({ page }) => {
    await arrive(page, visiting(), finishedStep());

    // `idle()` and friends carry the command the activity route builds from this
    // machine's own paths. A fixture path would be a command that fails.
    const command = panel(page).locator("code").first();
    await expect(command).toContainText("claude mcp add obsel");
    await expect(panel(page).getByRole("button", { name: "copy" })).toBeVisible();
  });

  test("a reader who opens it is not overruled by the next poll", async ({ page }) => {
    // The other half of the toggle fix. The board re-renders every second, and
    // the derivation says folded on this board, so a panel that took the derived
    // value back would shut under somebody a second after they opened it.
    const { serve } = await arrive(page, cascaded(), finishedStep());
    const steps = panel(page).locator("li[data-done]").first();
    await expect(steps).toBeHidden();

    await panel(page).getByText("how an agent joins").click();
    await expect(steps).toBeVisible();

    // Three polls' worth of fresh reads, all still saying folded.
    serve(calm());
    serve(cascaded());
    await page.waitForTimeout(2500);
    await expect(steps).toBeVisible();
  });

  test("stops counting a visitor's progress the moment the read fails", async ({ page }) => {
    /*
     * The same rule the ribbon follows: a number obsel cannot currently see is
     * withheld, never held at its last value. This panel is a claim about
     * somebody's agent, and "3 of 4" beside a broken connection is the same
     * false all-clear the rest of the board refuses to give.
     */
    const { serve } = await arrive(page, visiting(), finishedStep());
    await expect(panel(page).getByText("3 of 4")).toBeVisible();

    serve("fail");
    await expect(obselAlert(page)).toBeVisible();
    // Withheld, not replaced: "nobody has joined yet" is itself a claim about
    // the board, and a board obsel cannot read supports no claim at all.
    await expect(panel(page).getByText("3 of 4")).toBeHidden();
    await expect(panel(page).getByText("nobody has joined yet")).toBeHidden();
    await expect(panel(page).locator("li[data-done]").first()).toBeHidden();
  });
});

/**
 * The panel that registers somebody's own tables, which is the one place on the
 * board that writes.
 *
 * What is checked here is the half `your-data.ts`'s unit tests cannot see: that the
 * form is findable, that the body reaching `/api/tasks/register` is the one the
 * MCP door would have sent, and that a draft obsel would refuse never leaves the
 * browser. Which drafts are refused, and why, is covered in
 * `tests/dashboard-your-data.test.ts` and is not repeated.
 *
 * `openDashboard` intercepts the register route; its header says what that costs.
 * No browser test here proves a registration reaches DataHub.
 */
test.describe("bring your own data", () => {
  const panel = (page: Page) => page.locator('[aria-label="Bring your own data"]');
  const open = (page: Page) => panel(page).getByText("add a task").click();

  /** Open the board and then this panel's tab. See the sibling describe above. */
  const arrive = async (
    page: Page,
    ...args: Parameters<typeof openDashboard> extends [Page, ...infer R] ? R : never
  ) => {
    const handle = await openDashboard(page, ...args);
    await openTab(page, "your data");
    return handle;
  };

  test("is a panel with a heading, beside the door for an agent", async ({ page }) => {
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByRole("heading", { name: "bring your own data" })).toBeVisible();

    /*
     * Next to the door for an agent, which is the pair the README puts in this
     * order.
     *
     * This used to read the two panels' positions among the board's sections,
     * because they were consecutive rows under the graph. They are two tabs of
     * one panel now, so at most one of them is rendered at a time and an ordering
     * of sections cannot express the pairing. The tab strip is where the
     * adjacency lives, so that is what is asserted: same order, same claim, read
     * off the control that now carries it.
     */
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent?.trim() ?? ""),
    );
    const agent = tabs.indexOf("your agent");
    expect(agent).toBeGreaterThanOrEqual(0);
    expect(tabs.indexOf("your data")).toBe(agent + 1);
  });

  test("keeps the form folded, and counts nothing, on obsel's own board", async ({ page }) => {
    // The state the board is in on camera. The heading is painted; the four
    // fields are not, and there is no count, because a count of zero says
    // nothing the empty list does not.
    await arrive(page, cascaded(), finishedStep());

    await expect(panel(page).getByText("add a task")).toBeVisible();
    await expect(panel(page).locator("input").first()).toBeHidden();
    await expect(panel(page).getByText(/of yours/)).toBeHidden();
  });

  test("lists your own tasks with the identifiers your agent has to use", async ({ page }) => {
    await arrive(page, visiting(), finishedStep());
    await open(page);

    await expect(panel(page).getByText("2 of yours")).toBeVisible();

    /*
     * The identifiers, not the humanised names the rest of the board shows.
     * `clean_expenses` is what the reader typed and what their agent passes to
     * `report_complete`; a row reading "reads clean expenses" would be unusable
     * for the one thing this list is for.
     */
    const rows = await panel(page).evaluate((node) =>
      [...node.querySelectorAll("li[data-reported]")].map((li) => ({
        reported: li.getAttribute("data-reported"),
        text: (li as HTMLElement).innerText.replace(/\s+/g, " "),
      })),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].reported).toBe("true");
    expect(rows[0].text).toContain("reads expenses_csv, writes clean_expenses");
    // Registered and never reported. obsel has no fingerprint for it, so it has
    // nothing to compare against next time, and the row says so rather than
    // showing a tick that would mean obsel was watching it.
    expect(rows[1].reported).toBe("false");
    expect(rows[1].text).toContain("nothing reported yet");
  });

  test("sends obsel exactly the body the MCP door would have sent", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(1).fill("expenses_csv");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).locator("input").nth(3).fill("Expense cleaner");
    await panel(page).getByRole("button", { name: "register it" }).click();

    // Short names, not URNs. The route builds the URNs so the naming convention
    // lives in one place, and this board is not entitled to a second opinion.
    await expect
      .poll(() => registrations)
      .toEqual([
        {
          name: "clean_expenses",
          reads: ["expenses_csv"],
          writes: ["clean_expenses"],
          title: "Expense cleaner",
        },
      ]);

    // Cleared, and no row invented. The task appears when `/api/swarm` has it,
    // which this fixture's snapshot does not, so the list stays empty: an
    // optimistic row would be a claim obsel had not verified.
    await expect(panel(page).locator("input").nth(0)).toHaveValue("");
    await expect(panel(page).getByText(/of yours/)).toBeHidden();
  });

  test("splits a comma-separated list of tables into separate names", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    await panel(page).locator("input").nth(0).fill("joined_report");
    await panel(page).locator("input").nth(1).fill("clean_expenses, monthly_totals");
    await panel(page).locator("input").nth(2).fill("joined_report");
    await panel(page).getByRole("button", { name: "register it" }).click();

    await expect
      .poll(() => registrations.at(0)?.reads)
      .toEqual(["clean_expenses", "monthly_totals"]);
  });

  test("a draft obsel would refuse never leaves the browser", async ({ page }) => {
    const { registrations } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    // A task that writes nothing. The HTTP route accepts this and then has
    // nothing to say about it forever, so the form is the only thing that says so.
    await panel(page).locator("input").nth(0).fill("watches_nothing");
    await expect(panel(page).getByText(/Name the table this task writes/)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeDisabled();

    // A name that would build a URN nothing can parse back, for the same reason.
    await panel(page).locator("input").nth(2).fill("out");
    await panel(page).locator("input").nth(0).fill("clean,expenses");
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeDisabled();

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await expect(panel(page).getByRole("button", { name: "register it" })).toBeEnabled();

    expect(registrations, "a refused draft was sent anyway").toEqual([]);
  });

  test("shows obsel's own refusal rather than claiming the task landed", async ({ page }) => {
    const { refuseRegistration } = await arrive(page, cascaded(), finishedStep());
    await open(page);

    refuseRegistration(500, "DataHub is not reachable");

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).getByRole("button", { name: "register it" }).click();

    await expect(panel(page).getByText(/DataHub is not reachable/)).toBeVisible();
    // The draft survives a refusal. Clearing it would make the reader retype
    // four fields to retry something obsel might accept a second later.
    await expect(panel(page).locator("input").nth(0)).toHaveValue("clean_expenses");
  });

  test("stays open after a registration, rather than shutting on the reader", async ({ page }) => {
    /*
     * Found by registering a task in a real browser, not by reading the code.
     *
     * `your-data.ts` paints the form only on an empty board, so the first successful
     * registration flips that derivation to folded, and `chosen ?? expanded`
     * does not save it: the reader's panel was already open when they found it,
     * so their choice matched the derivation and nothing was recorded. The next
     * poll then shut the panel, hiding the confirmation and the new row, under
     * somebody about to register the second half of their pipeline.
     */
    const { serve } = await arrive(page, empty(), finishedStep());
    const field = panel(page).locator("input").first();
    // Painted, because there is nothing on this board at all.
    await expect(field).toBeVisible();

    await panel(page).locator("input").nth(0).fill("clean_expenses");
    await panel(page).locator("input").nth(2).fill("clean_expenses");
    await panel(page).getByRole("button", { name: "register it" }).click();
    await expect(panel(page).getByText(/Registered\./)).toBeVisible();

    // The board is no longer empty, which is what used to close it.
    serve(visiting());
    await expect(panel(page).getByText("2 of yours")).toBeVisible();
    await expect(field, "the panel shut itself after a registration").toBeVisible();
    await expect(panel(page).getByText(/Registered\./)).toBeVisible();

    // Closing it by hand still hands control back to the derivation.
    await panel(page).getByText("hide this").click();
    await expect(field).toBeHidden();
  });

  test("a reader who opens it is not overruled by the next poll", async ({ page }) => {
    // The same toggle rule the joining panel keeps, and it has to be kept
    // separately: this panel holds a half-typed form, so a fold that took the
    // derived value back every second would discard what somebody was writing.
    const { serve } = await arrive(page, cascaded(), finishedStep());
    const field = panel(page).locator("input").first();
    await expect(field).toBeHidden();

    await open(page);
    await field.fill("half_typed");

    serve(calm());
    serve(cascaded());
    await page.waitForTimeout(2500);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("half_typed");
  });
});

/**
 * A board holding exactly one task, rendered.
 *
 * `tests/dashboard-guide.test.ts` and `tests/dashboard-timing.test.ts` decide the
 * wording at a count of one and are not repeated here. What only a browser shows
 * is the whole board agreeing with itself: the headline, the screen-reader live
 * region and the write-back cell are three separate derivations of one count, and
 * nothing but the page puts them together in front of a reader.
 *
 * The state was unreachable until the bring-your-own-data panel registered tasks
 * one at a time, and "1 agents ready to run" was on a real screen before it.
 */
test.describe("a swarm of one", () => {
  test("says one agent, in every sentence that counts it", async ({ page }) => {
    await openDashboard(page, justOne("waiting"), finishedStep());

    const board = page.locator("main");
    await expect(board.getByRole("heading", { name: "1 agent ready to run" })).toBeVisible();

    // Nothing anywhere may say "1 agents", in any of the three states, including
    // the live region a screen reader is the only thing that reads.
    for (const state of ["waiting", "finished", "flagged"] as const) {
      await openDashboard(page, justOne(state), finishedStep());
      const text = await board.evaluate((node) => {
        const main = node as HTMLElement;
        // innerText misses the visually-hidden live region, which is exactly the
        // sentence most likely to be left plural because nobody sees it.
        return `${main.innerText} ${main.querySelector('[aria-live="polite"]')?.textContent ?? ""}`;
      });
      expect(text, `"1 agents" on the ${state} board`).not.toMatch(/\b1 agents\b/);
      expect(text, `"all 1" on the ${state} board`).not.toMatch(/\ball 1\b/);
      // The other half of the rule: a singular noun must not be glued to a plural
      // ratio. "1 of 1 finished agent is" is right; "1 of 3 finished agent" is the
      // bug this guards.
      expect(text, `a singular noun after a plural ratio on ${state}`).not.toMatch(
        /\b1 of ([2-9]|\d\d+) finished agent\b(?!s)/,
      );
    }
  });

  test("the settled board words its whole-swarm claim rather than counting to one", async ({
    page,
  }) => {
    await openDashboard(page, justOne("finished"), finishedStep());
    await expect(
      page.locator("main").getByRole("heading", { name: /the one agent finished/ }),
    ).toBeVisible();
  });

  test("the flagged board agrees its noun with finished and its verb with marked", async ({
    page,
  }) => {
    await openDashboard(page, justOne("flagged"), finishedStep());
    await expect(
      page.locator("main").getByRole("heading", { name: "1 of 1 finished agent is out of date" }),
    ).toBeVisible();
  });
});
