import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { STATE_LAB_COVERAGE } from "../src/components/whatsapp-state-lab";

const scenario = (id: string): string => `/?__stateLab=${id}`;

async function gotoScenario(page: Page, id: string): Promise<void> {
  await page.goto(scenario(id));
  await page.getByTestId("state-lab-ready").waitFor({ state: "attached" });
}

function browserHealth(page: Page): string[] {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    failures.push(`request: ${request.method()} ${new URL(request.url()).pathname}`),
  );
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === "http://127.0.0.1:3102" && response.status() >= 400)
      failures.push(`response: ${response.status()} ${url.pathname}`);
  });
  return failures;
}

async function attachEvidence(page: Page, testInfo: TestInfo, wc: string): Promise<void> {
  await testInfo.attach(`${wc}-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function expectHealthy(page: Page, failures: readonly string[]): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  expect(failures).toEqual([]);
}

test("WC-01 WC-20 WC-21 directory and responsive navigation", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  const mobile = testInfo.project.name === "mobile";
  await gotoScenario(page, "directory");

  await test.step("WC-01: the real proof app renders invented deterministic state", async () => {
    await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    await expect(page.getByText("Aster Garden")).toBeVisible();
  });

  await test.step("WC-21: search uses the rendered chat list", async () => {
    await page.getByRole("searchbox", { name: "Search chats" }).fill("Aster");
    await expect(page.getByText("Aster Garden")).toBeVisible();
    await expect(page.getByText("Beacon Workshop")).toBeHidden();
    await page.getByRole("searchbox", { name: "Search chats" }).fill("");
  });

  await test.step("WC-20: selection follows the viewport structure", async () => {
    await page.getByRole("button", { name: /Beacon Workshop/ }).click();
    await expect(page.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
    if (mobile) {
      await expect(page.getByRole("heading", { name: "Chats" })).toBeHidden();
      await page.getByRole("button", { name: "Back to chats" }).click();
      await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
    } else await expect(page.getByRole("heading", { name: "Chats" })).toBeVisible();
  });

  await attachEvidence(page, testInfo, "WC-20-21");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-10 WC-11 WC-23 WC-24 contact and group directory truth", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  const mobile = testInfo.project.name === "mobile";
  const navigate = (name: "Contacts" | "Groups") =>
    mobile
      ? page.getByLabel(name).click()
      : page.getByRole("button", { name, exact: true }).first().click();
  await gotoScenario(page, "directory");

  await navigate("Contacts");
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Aster Vale/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Celadon Finch/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Empty Conservatory/ })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search contacts" }).fill("aster-garden");
  await expect(page.getByRole("button", { name: /Aster Vale/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Celadon Finch/ })).toBeHidden();
  await page.getByRole("button", { name: /Aster Vale/ }).click();
  await expect(page.getByText("A. Vale", { exact: true })).toBeVisible();
  await expect(page.getByText("aster-garden", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("paragraph").filter({ hasText: "Invented fixture contact" }).last(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Common groups" })).toBeVisible();

  if (mobile) await page.getByRole("button", { name: "Back to directory" }).click();
  await navigate("Groups");
  await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Aster Vale/ })).toHaveCount(0);
  const known = page.getByRole("button", { name: /Beacon Workshop/ });
  await expect(known).toBeVisible();
  await expect(known).toContainText("3 participants");
  const empty = page.getByRole("button", { name: /Empty Conservatory/ });
  await expect(empty).toBeVisible();
  await expect(empty).toContainText("0 participants");
  const unknown = page.getByRole("button", { name: /Unloaded Orchard/ });
  await expect(unknown).toBeVisible();
  await expect(unknown).toContainText("Participants not loaded");
  await page.getByRole("button", { name: /Unloaded Orchard/ }).click();
  await expect(page.getByRole("heading", { name: "Unloaded Orchard" })).toBeVisible();
  await expect(page.getByText("Participants not loaded", { exact: true }).last()).toBeVisible();

  await attachEvidence(page, testInfo, "WC-10-11-23-24");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-25 settings disclose capabilities and persist preferences", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  const mobile = testInfo.project.name === "mobile";
  const openSettings = () =>
    mobile
      ? page.getByLabel("Settings").click()
      : page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await gotoScenario(page, "directory");

  if (!mobile) {
    const sidebar = page.locator('[data-slot="sidebar"][data-state]');
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");
    await page.locator('[data-slot="sidebar-trigger"]').click();
    await expect(sidebar).toHaveAttribute("data-state", "expanded");
  }

  await openSettings();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("State Lab", { exact: true })).toBeVisible();
  await expect(page.getByText("online", { exact: true })).toBeVisible();
  await expect(page.getByText(/Calls, archives, and publishing Updates/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Calls unavailable" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Archive unavailable" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Publish Update unavailable" })).toBeDisabled();

  await page.getByRole("combobox", { name: "Theme" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await page.evaluate(() =>
      Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
    ),
  ).toEqual({ theme: "dark" });

  await page.reload();
  await page.getByTestId("state-lab-ready").waitFor({ state: "attached" });
  await expect(page.locator("html")).toHaveClass(/dark/);
  if (!mobile)
    await expect(page.locator('[data-slot="sidebar"][data-state]')).toHaveAttribute(
      "data-state",
      "expanded",
    );
  await openSettings();
  await expect(page.getByRole("combobox", { name: "Theme" })).toContainText("Dark");

  await attachEvidence(page, testInfo, "WC-25");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-22 avatars render or fall back without retrying failures", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  const requests = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/avatar/state-lab-"))
      requests.set(path, (requests.get(path) ?? 0) + 1);
  });
  await gotoScenario(page, "directory");

  await test.step("WC-22: valid avatars render and shared tokens load once", async () => {
    await expect(page.getByRole("img", { name: "Aster Garden" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Cedar Observatory/ })).toBeVisible();
    expect(requests.get("/api/avatar/state-lab-shared")).toBe(1);
  });

  await test.step("WC-22: failed avatars retain initials and are negatively cached", async () => {
    const beacon = page.getByRole("button", { name: /Beacon Workshop/ });
    await expect(beacon.getByText("BW", { exact: true })).toBeVisible();
    await beacon.click();
    await expect(page.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
    expect(requests.get("/api/avatar/state-lab-broken")).toBe(1);
  });

  await attachEvidence(page, testInfo, "WC-22");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-14 stored media renders and seeks through opaque routes", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  await gotoScenario(page, "conversation");

  await test.step("WC-14: stored image, sticker, audio, video, and document are usable", async () => {
    await expect(page.getByRole("img", { name: "Invented image caption" })).toBeVisible();
    await expect(page.getByRole("img", { name: "sticker" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download" })).toBeVisible();
    const audio = page.getByLabel("Voice message");
    const video = page.getByLabel("Video message");
    await expect
      .poll(() => audio.evaluate((element) => (element as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLMediaElement).readyState))
      .toBeGreaterThanOrEqual(1);
  });

  await test.step("WC-14: missing and failed media remain distinct", async () => {
    await expect(page.getByText("Media reference missing")).toBeVisible();
    await expect(page.getByText("Media download failed")).toBeVisible();
  });

  await test.step("WC-14: browser seeking receives a private byte range", async () => {
    const proof = await page.evaluate(async () => {
      const response = await fetch("/api/media/state-lab-audio", {
        headers: { Range: "bytes=0-9" },
      });
      return {
        status: response.status,
        range: response.headers.get("content-range"),
        cache: response.headers.get("cache-control"),
        length: (await response.arrayBuffer()).byteLength,
      };
    });
    expect(proof).toEqual({
      status: 206,
      range: "bytes 0-9/280",
      cache: "private, no-store",
      length: 10,
    });
  });

  await attachEvidence(page, testInfo, "WC-14");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-12 WC-13 WC-30 WC-31 WC-32 WC-33 WC-35 conversation interactions", async ({
  page,
}, testInfo) => {
  const failures = browserHealth(page);
  await gotoScenario(page, "conversation");

  await test.step("WC-31: every message-kind fixture reaches the transcript", async () => {
    await expect(page.getByText("Invented incoming message")).toBeAttached();
    await expect(page.getByText("Choose an invented garden")).toBeAttached();
    await expect(page.getByText("This message was deleted")).toBeAttached();
    await expect(page.getByText(/Unsupported message/)).toBeAttached();
  });

  await test.step("WC-12: poll controls become results while unknown content stays explicit", async () => {
    await expect(page.getByText("2 votes", { exact: true })).toBeAttached();
    await expect(page.getByText("1 vote", { exact: true })).toBeAttached();
    await expect(page.getByText("Unsupported message (inventedEnvelope)")).toBeAttached();
    await expect(page.getByText(/pollUpdateMessage/)).toHaveCount(0);
  });

  await test.step("WC-13: every receipt and durable operation state is explicit", async () => {
    for (const label of ["Pending", "Sent", "delivered", "read", "played", "Failed"])
      await expect(page.getByLabel(label).first()).toBeAttached();
    await expect(page.getByText("2 delivered · 1 read", { exact: true })).toBeAttached();
    for (const label of ["Queued", "Preparing", "Sending", "Sent, syncing"])
      await expect(page.getByText(label, { exact: true })).toBeAttached();
    await expect(page.getByText("Could not send")).toBeAttached();
    await expect(page.getByText("Delivery could not be confirmed")).toBeAttached();
  });

  await test.step("WC-32: a real pointer hover exposes message actions", async () => {
    const content = page.getByText("Invented incoming message");
    await content.scrollIntoViewIfNeeded();
    if (testInfo.project.name !== "mobile")
      await content.locator("xpath=ancestor::div[@data-slot='message']").hover();
    await expect(page.getByRole("button", { name: "React" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Message actions" }).first()).toBeVisible();
  });

  await test.step("WC-30: saved paging remains an explicit command", async () => {
    const paging = page.getByRole("button", { name: "Load older saved messages" });
    await paging.scrollIntoViewIfNeeded();
    await expect(paging).toBeVisible();
    await paging.click();
  });

  await test.step("WC-33: the messaging composer accepts a durable text send", async () => {
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Invented browser message");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(composer).toHaveValue("");
  });

  await test.step("WC-35: uncertainty is visibly distinct from failure", async () => {
    await expect(page.getByText("Delivery could not be confirmed")).toBeAttached();
    await expect(page.getByText("Could not send")).toBeAttached();
  });

  await attachEvidence(page, testInfo, "WC-12-13-30-31-32-33-35");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});

test("WC-26 connection states remain truthful", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  for (const phase of STATE_LAB_COVERAGE.connectionPhases.filter((phase) => phase !== "online")) {
    await test.step(`WC-26: ${phase}`, async () => {
      await gotoScenario(page, `connection-${phase.replaceAll("_", "-")}`);
      await expect(page.locator("body")).toContainText(phase.replaceAll("_", " "));
    });
  }
  await gotoScenario(page, "connection-online");
  await expect(page.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await attachEvidence(page, testInfo, "WC-26");
  await test.step("WC-02: browser health and viewport integrity", () =>
    expectHealthy(page, failures));
});
