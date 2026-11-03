import { expect, test, type Page } from "@playwright/test";

const LOCAL_PEER = "peerHost=127.0.0.1&peerPort=9000&peerPath=/&peerSecure=0";

const mySlot = (page: Page) =>
  page.evaluate(() => (window as unknown as { gms: { client: { slot: string } } }).gms.client.slot);

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => localStorage.setItem("gms-view", "2d"));
});

test("solo practice uses the role picked in the lobby", async ({ page }) => {
  await page.goto("/");
  await page.selectOption("#role", "M2");
  await page.click("#solo");
  await expect(page.locator("#game")).toBeVisible();
  expect(await mySlot(page)).toBe("M2");
  await expect(page.locator("#roster li", { hasText: "(you)" }).locator(".slot")).toHaveText("M2");
});

test("a role already taken in the room can't be picked by a second player", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const joinCtx = await browser.newContext();
  for (const ctx of [hostCtx, joinCtx]) await ctx.addInitScript(() => localStorage.setItem("gms-view", "2d"));
  const host = await hostCtx.newPage();
  const guest = await joinCtx.newPage();

  await host.goto(`/?${LOCAL_PEER}`);
  await host.fill("#name", "Hosty");
  await host.selectOption("#role", "R1");
  await host.click("#create");
  await expect(host.locator("#room-code")).toBeVisible({ timeout: 20_000 });
  const code = (await host.locator("#room-code").textContent())!.trim();
  expect(await mySlot(host)).toBe("R1");

  // The guest asks for R1 too: refused, told why, and R1 is greyed out.
  await guest.goto(`/?${LOCAL_PEER}`);
  await guest.fill("#name", "Guesty");
  await guest.selectOption("#role", "R1");
  await guest.fill("#code", code);
  await guest.click("#join-form button[type=submit]");
  await expect(guest.locator("#lobby-status")).toHaveText("R1 is already taken in this room. Pick another role.", { timeout: 20_000 });
  await expect(guest.locator("#lobby")).toBeVisible();
  await expect(guest.locator(`#role option[value="R1"]`)).toHaveJSProperty("disabled", true);
  await expect(guest.locator('#role option[value="R1"]')).toHaveText("R1 (taken)");
  await expect(guest.locator("#role")).toHaveValue("");

  // Picking a free role works.
  await guest.selectOption("#role", "H2");
  await guest.click("#join-form button[type=submit]");
  await expect(guest.locator("#game")).toBeVisible({ timeout: 25_000 });
  expect(await mySlot(guest)).toBe("H2");

  // The host still has R1, and sees the guest as H2.
  const humans = () =>
    host.evaluate(() =>
      [...(window as unknown as { gms: { client: { players: Map<string, { isBot: boolean; slot: string; name: string }> } } }).gms.client.players.values()]
        .filter((p) => !p.isBot)
        .map((p) => `${p.slot}:${p.name}`)
        .sort(),
    );
  await expect.poll(humans, { timeout: 10_000 }).toEqual(["H2:Guesty", "R1:Hosty"]);

  await hostCtx.close();
  await joinCtx.close();
});
