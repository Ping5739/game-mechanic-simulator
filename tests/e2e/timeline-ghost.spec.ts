import { expect, test, type Page } from "@playwright/test";

const LOCAL_PEER = "peerHost=127.0.0.1&peerPort=9000&peerPath=/&peerSecure=0";

type ClientLike = {
  loopTime(): number;
  myPos: { x: number; y: number };
  epoch: number;
  ghost(): { pos: { x: number; y: number }; dest: { x: number; y: number } } | undefined;
};
const loopTime = (page: Page) => page.evaluate(() => (window as unknown as { gms: { client: ClientLike } }).gms.client.loopTime());
const ghost = (page: Page) => page.evaluate(() => (window as unknown as { gms: { client: ClientLike } }).gms.client.ghost());
const myPos = (page: Page) => page.evaluate(() => (window as unknown as { gms: { client: ClientLike } }).gms.client.myPos);

test("the timeline shows every mechanic and jumps when clicked", async ({ page }) => {
  await page.goto("/");
  await page.click("#solo");
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator(".tl-label")).toHaveCount(7);
  await expect(page.locator(".tl-block")).toHaveCount(7);

  // Clicking a mechanic's name jumps to 2 s before it (Converge is at 0:25).
  await page.locator(".tl-label", { hasText: "Converge" }).click();
  await expect(page.locator("#feed li.note").first()).toHaveText("Jumped to 0:23");
  expect(await loopTime(page)).toBeGreaterThan(22.5);
  expect(await loopTime(page)).toBeLessThan(25);
  await expect(page.locator("#cast-name")).toHaveText("Converge", { timeout: 4000 });

  // Clicking the track jumps to that exact moment (here: ~half way, 0:29).
  const box = (await page.locator(".tl-track").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.locator("#feed li.note").first()).toHaveText(/Jumped to 0:2[89]/);
  await expect.poll(() => loopTime(page)).toBeGreaterThan(28.5);

  // Jumping into the middle of a cast restarts that cast part-way through.
  await page.locator(".tl-label", { hasText: "Scatter" }).click(); // 0:15
  await page.waitForTimeout(3000); // now 0:18, mid Scatter (0:17–0:22)
  await expect(page.locator("#cast-name")).toHaveText("Scatter");
});

test("the ghost leads you to the right spot and can be hidden", async ({ page }) => {
  await page.goto("/");
  await page.click("#solo");
  await expect(page.locator("#game")).toBeVisible();
  await expect.poll(async () => (await ghost(page)) !== undefined).toBe(true);

  // During "Searing Ring" (get out), the ghost for MT heads to the out spot: 13 units north.
  await page.locator(".tl-label", { hasText: "Searing Ring" }).click(); // jumps to 0:01
  await page.waitForTimeout(4000); // cast starts at 0:03, reaction + travel
  const g = (await ghost(page))!;
  expect(g.dest.x).toBeCloseTo(0, 0);
  expect(g.dest.y).toBeCloseTo(-13, 0);
  expect(Math.hypot(g.pos.x, g.pos.y)).toBeGreaterThan(9);

  // Following the ghost keeps you safe: walk north and the ring doesn't hit you.
  await page.keyboard.down("w");
  await page.waitForTimeout(1600);
  await page.keyboard.up("w");
  await expect(page.locator("#feed li", { hasText: "Searing Ring" }).first()).toBeVisible({ timeout: 6000 });
  await expect(page.locator("#feed li", { hasText: "MT was hit by Searing Ring" })).toHaveCount(0);

  // Toggle with the checkbox and with G.
  await expect(page.locator("#ghost-toggle")).toBeChecked();
  await page.keyboard.press("g");
  await expect(page.locator("#ghost-toggle")).not.toBeChecked();
  await page.locator("#ghost-toggle").check();
  await expect(page.locator("#ghost-toggle")).toBeChecked();
});

test("a host's timeline jump moves everyone; guests can't jump", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const joinCtx = await browser.newContext();
  // Networking test: 2D keeps it fast in software-rendered test browsers.
  for (const ctx of [hostCtx, joinCtx]) await ctx.addInitScript(() => localStorage.setItem("gms-view", "2d"));
  const host = await hostCtx.newPage();
  const joiner = await joinCtx.newPage();

  await host.goto(`/?${LOCAL_PEER}`);
  await host.click("#create");
  await expect(host.locator("#room-code")).toBeVisible({ timeout: 20_000 });
  const code = (await host.locator("#room-code").textContent())!.trim();
  await joiner.goto(`/?${LOCAL_PEER}`);
  await joiner.fill("#code", code);
  await joiner.click("#join-form button[type=submit]");
  await expect(joiner.locator("#game")).toBeVisible({ timeout: 25_000 });

  // The guest walks far off, then the host jumps to just before "Hollow Core".
  await joiner.keyboard.down("a");
  await joiner.waitForTimeout(1500);
  await joiner.keyboard.up("a");
  await host.locator(".tl-label", { hasText: "Hollow Core" }).click(); // 0:08
  await expect(joiner.locator("#feed li.note").first()).toHaveText("Jumped to 0:08");
  const t = await loopTime(joiner);
  expect(t).toBeGreaterThan(7.5);
  expect(t).toBeLessThan(10);
  // The guest was put back on their default spot (OT: 5 units north).
  const p = await myPos(joiner);
  expect(Math.hypot(p.x - 0, p.y - -5)).toBeLessThan(1.5);

  // Guests see the timeline but can't move it.
  await joiner.locator(".tl-label", { hasText: "Meteor Rain" }).click();
  await expect(joiner.locator("#toast")).toHaveText("Only the host can move the timeline.");
  expect(await loopTime(host)).toBeLessThan(15);

  await hostCtx.close();
  await joinCtx.close();
});
