import { expect, test, type Page } from "@playwright/test";

const LOCAL_PEER = "peerHost=127.0.0.1&peerPort=9000&peerPath=/&peerSecure=0";

type Gms = {
  client: {
    loopTime(): number;
    myPos: { x: number; y: number };
    paused: boolean;
    ghost(): { pos: { x: number; y: number }; dest: { x: number; y: number } } | undefined;
  };
  view(): { kind: string; showGhost: boolean; yaw?: number };
};
const g = <T>(page: Page, fn: (gms: Gms) => T) =>
  page.evaluate(`(${fn.toString()})(window.gms)`) as Promise<T>;

async function startSolo(page: Page) {
  await page.goto("/");
  await page.click("#solo");
  await expect(page.locator("#game")).toBeVisible();
}

async function hold(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test("pause freezes the fight but the ghost and its route stay available", async ({ page }) => {
  await startSolo(page);
  // Pause mid "Searing Ring" (cast 0:03–0:07): the ghost is heading for the out spot.
  await page.locator(".tl-label", { hasText: "Searing Ring" }).click(); // 0:01
  await page.waitForTimeout(2600);
  await page.keyboard.press("Space");
  await expect(page.locator("#paused-banner")).toBeVisible();
  await expect(page.locator("#pause")).toHaveText("Resume");

  const t0 = await g(page, (x) => x.client.loopTime());
  const p0 = await g(page, (x) => x.client.myPos);
  await hold(page, "d", 600); // you can't move while paused
  await page.waitForTimeout(800);
  expect(await g(page, (x) => x.client.loopTime())).toBe(t0);
  expect(await g(page, (x) => x.client.myPos)).toEqual(p0);
  await expect(page.locator("#cast-name")).toHaveText("Searing Ring");

  // G still toggles the ghost while paused, and the ghost still shows its route.
  const ghost = await g(page, (x) => x.client.ghost());
  expect(ghost).toBeDefined();
  expect(Math.hypot(ghost!.dest.x - ghost!.pos.x, ghost!.dest.y - ghost!.pos.y)).toBeGreaterThan(1);
  await page.keyboard.press("g");
  expect(await g(page, (x) => x.view().showGhost)).toBe(false);
  await page.keyboard.press("g");
  expect(await g(page, (x) => x.view().showGhost)).toBe(true);

  // Jumping while paused stays paused, at the new time.
  await page.locator(".tl-label", { hasText: "Scatter" }).click(); // 0:15
  await expect(page.locator("#feed li.note").first()).toHaveText("Jumped to 0:15");
  await page.waitForTimeout(500);
  expect(await g(page, (x) => x.client.paused)).toBe(true);
  expect(await g(page, (x) => x.client.loopTime())).toBeCloseTo(15, 0);

  // Resume: time moves again from where it stopped.
  await page.click("#pause");
  await expect(page.locator("#paused-banner")).toBeHidden();
  await page.waitForTimeout(1000);
  const t1 = await g(page, (x) => x.client.loopTime());
  expect(t1).toBeGreaterThan(15.6);
  expect(t1).toBeLessThan(16.6);
});

test("3D is the default view; V switches to 2D and back", async ({ page }) => {
  await startSolo(page);
  await expect.poll(() => g(page, (x) => x.view().kind)).toBe("3d");
  await expect(page.locator("#arena3d")).toBeVisible();
  await expect(page.locator("#arena")).toBeHidden();
  await expect(page.locator(".label3d.slot-label")).toHaveCount(8);
  await page.keyboard.press("v");
  await expect(page.locator("#arena")).toBeVisible();
  await expect(page.locator("#arena3d")).toBeHidden();
  await page.click(`[data-view="3d"]`);
  await expect(page.locator("#arena3d")).toBeVisible();
});

test("in 3D, right-drag turns the camera and W moves the way the camera looks", async ({ page }) => {
  await startSolo(page);
  await expect.poll(() => g(page, (x) => x.view().kind)).toBe("3d");
  const box = (await page.locator("#arena3d").boundingBox())!;

  // A left-click does nothing (no click-to-move).
  const before = await g(page, (x) => x.client.myPos);
  await page.mouse.click(box.x + 50, box.y + 50);
  await page.waitForTimeout(400);
  expect(await g(page, (x) => x.client.myPos)).toEqual(before);

  // Turn the camera 90° to the right (300 px × 0.3°/px) so it looks east.
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 600, box.y + 300, { steps: 12 });
  await page.mouse.up({ button: "right" });
  expect(await g(page, (x) => x.view().yaw)).toBeCloseTo(90, 0);

  const start = await g(page, (x) => x.client.myPos);
  await hold(page, "w", 700);
  const end = await g(page, (x) => x.client.myPos);
  expect(end.x - start.x).toBeGreaterThan(2.5); // moved east
  expect(Math.abs(end.y - start.y)).toBeLessThan(0.5);
});

test("guests see the host's pause and can't pause or move", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const joinCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await joinCtx.newPage();
  await host.goto(`/?${LOCAL_PEER}`);
  await host.click("#create");
  await expect(host.locator("#room-code")).toBeVisible({ timeout: 20_000 });
  const code = (await host.locator("#room-code").textContent())!.trim();
  await guest.goto(`/?${LOCAL_PEER}`);
  await guest.fill("#code", code);
  await guest.click("#join-form button[type=submit]");
  await expect(guest.locator("#game")).toBeVisible({ timeout: 25_000 });
  await guest.waitForTimeout(500);

  await host.keyboard.press("Space");
  await expect(guest.locator("#paused-banner")).toBeVisible();
  await expect(guest.locator("#paused-who")).toHaveText("The host paused the encounter.");
  const t0 = await g(guest, (x) => x.client.loopTime());
  const p0 = await g(guest, (x) => x.client.myPos);
  await hold(guest, "s", 500);
  await guest.keyboard.press("Space");
  await expect(guest.locator("#toast")).toHaveText("Only the host can pause.");
  await guest.waitForTimeout(500);
  expect(await g(guest, (x) => x.client.loopTime())).toBeCloseTo(t0, 1);
  expect(await g(guest, (x) => x.client.myPos)).toEqual(p0);

  await host.keyboard.press("Space");
  await expect(guest.locator("#paused-banner")).toBeHidden();
  await guest.waitForTimeout(800);
  expect(await g(guest, (x) => x.client.loopTime())).toBeGreaterThan(t0 + 0.4);

  await hostCtx.close();
  await joinCtx.close();
});
