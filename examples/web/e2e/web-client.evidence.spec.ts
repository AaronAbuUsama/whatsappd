import { expect, test, type Page, type TestInfo } from "@playwright/test";

const story = (id: string): string => `/iframe.html?id=whatsapp-state-lab--${id}&viewMode=story`;

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
    if (url.origin === "http://127.0.0.1:6006" && response.status() >= 400)
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

test("WC-01 WC-20 WC-21 WC-23 WC-24 directory and responsive navigation", async ({
  page,
}, testInfo) => {
  const failures = browserHealth(page);
  const mobile = testInfo.project.name === "mobile";
  await page.goto(story("desktop-directory"));

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

  if (mobile)
    await test.step("WC-23 WC-24: mobile directories stay distinct", async () => {
      await page.getByLabel("Contacts").click();
      await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
      await page.getByLabel("Groups").click();
      await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
      await expect(page.getByText("Participants not loaded")).toBeVisible();
    });

  await attachEvidence(page, testInfo, "WC-20-21-23-24");
  await expectHealthy(page, failures);
});

test("WC-30 WC-31 WC-32 WC-33 WC-35 conversation interactions", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  await page.goto(
    story(
      testInfo.project.name === "mobile"
        ? "mobile-conversation-matrix"
        : "desktop-conversation-matrix",
    ),
  );

  await test.step("WC-31: every message-kind fixture reaches the transcript", async () => {
    await expect(page.getByText("Invented incoming message")).toBeAttached();
    await expect(page.getByText("Choose an invented garden")).toBeAttached();
    await expect(page.getByText("This message was deleted")).toBeAttached();
    await expect(page.getByText(/Unsupported message/)).toBeAttached();
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

  await attachEvidence(page, testInfo, "WC-30-31-32-33-35");
  await expectHealthy(page, failures);
});

test("WC-26 connection states remain truthful", async ({ page }, testInfo) => {
  const failures = browserHealth(page);
  const mobile = testInfo.project.name === "mobile" ? "mobile-" : "";
  for (const phase of [
    "disconnected",
    "connecting",
    "pairing",
    "authenticated",
    "backing-off",
    "logged-out",
    "suspended",
    "stale",
    "closed",
  ]) {
    await test.step(`WC-26: ${phase}`, async () => {
      await page.goto(story(`${mobile}connection-${phase}`));
      await expect(page.locator("body")).toContainText(phase.replaceAll("-", " "));
    });
  }
  await page.goto(story(`${mobile}connection-online`));
  await expect(page.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await attachEvidence(page, testInfo, "WC-26");
  await expectHealthy(page, failures);
});
