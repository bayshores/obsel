import { expect, test } from "@playwright/test";

import { empty } from "./fixtures/swarm";
import { openDashboard } from "./fixtures/mount";

/**
 * The API token: pasted once, kept, and sent on every mutation the board makes.
 *
 * Every mutating route obsel serves requires a bearer token, including the four
 * the board itself calls. `src/server/http/auth.ts` records why that changed and
 * what was wrong with the arrangement before it. The consequence on this side is
 * a field, a store, and a header, and this is the only suite that can prove all
 * three: `localStorage` is a browser's, and a fake one would only assert what
 * its author already believed.
 *
 * The interceptors in `mount.ts` answer before any gate, so a board that stopped
 * attaching the header would still pass every other browser test here while
 * every button was refused against a real obsel. That is what `mutationAuth`
 * exists for.
 */
test.describe("the API token", () => {
  const field = "API token";

  test("a pasted token rides on the next mutation", async ({ page }) => {
    const { launches, mutationAuth } = await openDashboard(page, empty());

    await page.getByLabel(field).fill("paste-me-1234");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await page.getByRole("button", { name: /Run the demo agents/ }).click();

    await expect.poll(() => launches).toEqual(["run"]);
    expect(mutationAuth).toEqual(["Bearer paste-me-1234"]);
  });

  test("no token means no header, and obsel's own refusal is what the reader sees", async ({
    page,
  }) => {
    /*
     * The board invents no client-side check for an empty field. A button that
     * refused itself would be this page guessing at an answer obsel is the only
     * one entitled to give, and the sentence obsel returns names the variable
     * and what to do about it.
     */
    const { launches, mutationAuth } = await openDashboard(page, empty());

    await page.getByRole("button", { name: /Run the demo agents/ }).click();

    await expect.poll(() => launches).toEqual(["run"]);
    expect(mutationAuth).toEqual([null]);
  });

  test("a stored token survives a reload, and forgetting it takes it off the wire", async ({
    page,
  }) => {
    const first = await openDashboard(page, empty());
    await page.getByLabel(field).fill("survives-a-reload");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("API token stored")).toBeVisible();

    // A real reload against real storage. The demo path reloads constantly, and
    // a token that had to be pasted again each time is one nobody would paste.
    await page.reload();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.getByText("API token stored")).toBeVisible();

    await page.getByRole("button", { name: /Run the demo agents/ }).click();
    await expect.poll(() => first.launches).toEqual(["run"]);
    expect(first.mutationAuth.at(-1)).toBe("Bearer survives-a-reload");

    await page.getByRole("button", { name: "Forget", exact: true }).click();
    await expect(page.getByLabel(field)).toBeVisible();
    await page.reload();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    await expect(page.getByLabel(field)).toBeVisible();
  });
});
