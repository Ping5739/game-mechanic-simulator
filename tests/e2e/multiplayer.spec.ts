import { expect, test, type Page } from "@playwright/test";

const LOCAL_PEER = "peerHost=127.0.0.1&peerPort=9000&peerPath=/&peerSecure=0";

type Gms = {
  client: { myId: string; myPos: { x: number; y: number }; players: Map<string, { isBot: boolean; slot: string; name: string }>; feed: unknown[] };
};

const humans = (page: Page) =>
  page.evaluate(() => {
    const g = (window as unknown as { gms: Gms }).gms;
    return [...g.client.players.values()].filter((p) => !p.isBot).map((p) => `${p.slot}:${p.name}`).sort();
  });

const renderedPos = (page: Page, slot: string) =>
  page.evaluate((slot) => {
    const g = (window as unknown as { gms: Gms & { client: { renderPositions(): Map<string, { x: number; y: number }> } } }).gms;
    const p = [...g.client.players.values()].find((p) => p.slot === slot)!;
    const id = [...g.client.players.entries()].find(([, v]) => v === p)![0];
    return g.client.renderPositions().get(id)!;
  }, slot);

async function hostRoom(page: Page, query: string, name = "Hosty"): Promise<string> {
  await page.goto(`/?${query}`);
  await page.fill("#name", name);
  await page.click("#create");
  await expect(page.locator("#room-code")).toBeVisible({ timeout: 20_000 });
  return (await page.locator("#room-code").textContent())!.trim();
}

async function joinRoom(page: Page, query: string, code: string, name = "Joiner"): Promise<void> {
  await page.goto(`/?${query}`);
  await page.fill("#name", name);
  await page.fill("#code", code);
  await page.click("#join-form button[type=submit]");
  await expect(page.locator("#game")).toBeVisible({ timeout: 25_000 });
}

test("solo practice runs the encounter and reports mechanics", async ({ page }) => {
  await page.goto("/");
  await page.fill("#name", "Solo");
  await page.click("#solo");
  await expect(page.locator("#game")).toBeVisible();
  await expect(page.locator("#roster li")).toHaveCount(8);
  // First mechanic resolves ~10 s in (3 s lead-in + 3 s + 4 s cast).
  await expect(page.locator("#feed li").first()).toBeVisible({ timeout: 15_000 });
  const before = await renderedPos(page, "MT");
  await page.keyboard.down("d");
  await page.waitForTimeout(600);
  await page.keyboard.up("d");
  const after = await renderedPos(page, "MT");
  expect(after.x - before.x).toBeGreaterThan(2);
});

for (const mode of [
  { label: "PeerJS (local PeerServer)", query: LOCAL_PEER, sameContext: false },
  { label: "same-browser tabs", query: "net=local", sameContext: true },
]) {
  test(`two players share a room over ${mode.label}`, async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const joinCtx = mode.sameContext ? hostCtx : await browser.newContext();
    const host = await hostCtx.newPage();
    const joiner = await joinCtx.newPage();

    const code = await hostRoom(host, mode.query);
    expect(code).toMatch(/^[A-Z0-9]{5}$/);
    await joinRoom(joiner, mode.query, code);

    // Both sides see both humans in the party.
    await expect.poll(() => humans(host), { timeout: 10_000 }).toEqual(["MT:Hosty", "OT:Joiner"]);
    await expect.poll(() => humans(joiner), { timeout: 10_000 }).toEqual(["MT:Hosty", "OT:Joiner"]);

    // The joiner moves; the host sees it.
    await joiner.waitForTimeout(500);
    const start = await renderedPos(host, "OT");
    await joiner.keyboard.down("s");
    await joiner.waitForTimeout(800);
    await joiner.keyboard.up("s");
    await expect.poll(async () => (await renderedPos(host, "OT")).y - start.y, { timeout: 5_000 }).toBeGreaterThan(2);

    // Mechanics resolve for the joiner too.
    await expect(joiner.locator("#feed li").first()).toBeVisible({ timeout: 15_000 });

    // When the joiner leaves, a bot takes the slot back.
    await joiner.click("#leave");
    await expect.poll(() => humans(host), { timeout: 15_000 }).toEqual(["MT:Hosty"]);

    await hostCtx.close();
    if (!mode.sameContext) await joinCtx.close();
  });
}

test("joining a code that doesn't exist explains the problem", async ({ page }) => {
  await page.goto(`/?net=local`);
  await page.fill("#code", "ZZZZZ");
  await page.click("#join-form button[type=submit]");
  await expect(page.locator("#lobby-status")).toContainText("No room with code ZZZZZ");
});
