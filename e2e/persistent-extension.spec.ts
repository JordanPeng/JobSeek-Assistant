import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

import {
  FIXTURE_FRAME_ORIGIN,
  FIXTURE_ORIGIN,
  startFixtureServer,
} from "../fixtures/ats/server.mjs";

const root = process.cwd();
const extensionPath = path.join(
  root,
  "apps",
  "extension",
  ".output",
  "chromium-mv3-e2e",
);
const e2eManifestPath = path.join(extensionPath, "manifest.json");
const productionManifestPath = path.join(
  root,
  "apps",
  "extension",
  ".output",
  "edge-mv3",
  "manifest.json",
);
const profilePath = path.join(root, "e2e", "browser-profiles", "persistent");
const PDF = Buffer.from("%PDF-1.4\n", "utf8");
const browserChannel = process.env.JOBSEEK_E2E_CHANNEL ?? "chromium";

const profile = {
  facts: [
    {
      path: "name.full",
      value: "Avery Fixture",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "name.preferred",
      value: "Avery",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "contact.email",
      value: "avery.fixture@example.test",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "contact.phone",
      value: "+1 555 010 2121",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "links.linkedin",
      value: "https://www.linkedin.com/in/avery-fixture",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "address.country",
      value: "United States",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "address.city",
      value: "Seattle",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "authorization.work_authorized",
      value: "Yes",
      sensitivity: "authorization",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "links.portfolio",
      value: "https://portfolio.example.test/avery",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
  ],
} as const;

const attachment = {
  displayName: "Avery-Fixture-Resume.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: PDF.byteLength,
  sha256: "fixture-only-pdf-sha256",
  dataBase64: PDF.toString("base64"),
};

function normalizePrompt(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\(\s*required\s*\)/g, " ")
    .replace(/\brequired\b/g, " ")
    .replace(/\boptional\b/g, " ")
    .replace(/[*:?]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

async function extensionWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? context.waitForEvent("serviceworker");
}

async function targetTabId(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (targetUrl) => {
    const tab = (await chrome.tabs.query({})).find(
      (candidate) => candidate.url === targetUrl,
    );
    if (tab?.id === undefined)
      throw new Error(`Fixture tab not found: ${targetUrl}`);
    return tab.id;
  }, url);
}

async function sendToRuntime(
  worker: Worker,
  tabId: number,
  request: object,
): Promise<any> {
  return worker.evaluate(
    async ({ tabId: id, message }) => {
      await chrome.scripting.executeScript({
        target: { tabId: id },
        files: ["/page-runtime.js"],
      });
      return chrome.tabs.sendMessage(id, message);
    },
    { tabId, message: request },
  );
}

async function sendExtensionCommand(
  context: BrowserContext,
  worker: Worker,
  tabId: number,
  command: object,
): Promise<any> {
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    return await page.evaluate(
      async ({ tabId, command }) => {
        await chrome.tabs.update(tabId, { active: true });
        const response = await chrome.runtime.sendMessage(command);
        if (!response.ok) throw new Error(response.error.message);
        return response.result;
      },
      { tabId, command },
    );
  } finally {
    await page.close();
  }
}

test.describe("JobSeek Assistant persistent Chromium extension", () => {
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let worker: Worker;
  let genericPage: Page;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  const requests: string[] = [];

  test.beforeAll(async () => {
    await fs.rm(profilePath, { recursive: true, force: true });
    server = await startFixtureServer();
    context = await chromium.launchPersistentContext(profilePath, {
      channel: browserChannel,
      headless: browserChannel === "chromium",
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    context.on("request", (request) => requests.push(request.url()));
    worker = await extensionWorker(context);
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(path.dirname(profilePath), { recursive: true, force: true });
  });

  test("builds e2e and production manifests with their intentionally different permissions", () => {
    expect(existsSync(e2eManifestPath)).toBe(true);
    const e2eManifest = JSON.parse(readFileSync(e2eManifestPath, "utf8"));
    expect(e2eManifest.host_permissions).toEqual([
      `${FIXTURE_ORIGIN}/*`,
      `${FIXTURE_FRAME_ORIGIN}/*`,
    ]);
    expect(e2eManifest.permissions).not.toContain("http://127.0.0.1/*");
    expect(e2eManifest.content_security_policy.extension_pages).toBe(
      "script-src 'self'; object-src 'self'",
    );

    execFileSync(
      process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "npm run build"]
        : ["run", "build"],
      {
        cwd: root,
        stdio: "pipe",
      },
    );
    const productionManifest = JSON.parse(
      readFileSync(productionManifestPath, "utf8"),
    );
    expect(productionManifest.host_permissions).toBeUndefined();
    expect(productionManifest.optional_host_permissions).toEqual([
      "https://*/*",
    ]);
  });

  test("inspects generic fixture without overwriting, sensitive filling, or authorization opt-in", async () => {
    genericPage = await context.newPage();
    await genericPage.goto(`${FIXTURE_ORIGIN}/generic`, {
      waitUntil: "domcontentloaded",
    });
    const tabId = await targetTabId(worker, genericPage.url());
    const result = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.inspect",
      context: {
        profile,
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: false,
        },
      },
    });

    expect(result.inspection.siteFamily).toBe("generic");
    expect(result.inspection.descriptors.length).toBeGreaterThanOrEqual(16);
    expect(result.inspection.summary.blocked).toBeGreaterThanOrEqual(6);
    expect(
      result.inspection.plan.items.some(
        (item: any) => item.reason === "preserve.existing",
      ),
    ).toBe(true);
    const authorization = result.inspection.classifications.find(
      (field: any) => field.kind === "authorization.work_authorized",
    );
    expect(
      result.inspection.plan.items.find(
        (item: any) => item.ref === authorization?.ref,
      )?.operation,
    ).toBe("suggest");
    expect(
      result.inspection.classifications.filter(
        (field: any) => field.sensitivity === "manual",
      ).length,
    ).toBeGreaterThanOrEqual(6);
    await expect(genericPage.locator("#salary")).toHaveValue("");
    await expect(genericPage.locator("#eeo")).toHaveValue("");
  });

  test("fills ordinary controls, attached resume, and React-style input without navigating", async () => {
    const tabId = await targetTabId(worker, genericPage.url());
    const inspection = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.inspect",
      context: {
        profile,
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: true,
        },
      },
    });
    const checkbox = inspection.inspection.descriptors.find(
      (field: any) => field.elementId === "updates",
    );
    expect(checkbox).toBeTruthy();
    const answers = [
      {
        id: "fixture-updates",
        normalizedQuestion: normalizePrompt(checkbox.promptText),
        fieldType: "checkbox",
        answer: "yes",
        scopeType: "global",
        sensitivity: "ordinary",
        confirmed: true,
        active: true,
      },
    ];

    const result = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.fill",
      context: {
        profile,
        answers,
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: true,
        },
        resumeAttachment: attachment,
      },
    });
    expect(
      result.outcomes.filter((outcome: any) => outcome.status === "filled")
        .length,
    ).toBeGreaterThanOrEqual(9);
    await expect(genericPage.locator("#full-name")).toHaveValue(
      "Avery Fixture",
    );
    await expect(genericPage.locator("#email")).toHaveValue(
      "avery.fixture@example.test",
    );
    await expect(genericPage.locator("#phone")).toHaveValue("+1 555 010 2121");
    await expect(genericPage.locator("#linkedin")).toHaveValue(
      "https://www.linkedin.com/in/avery-fixture",
    );
    await expect(genericPage.locator("#country")).toHaveValue("US");
    await expect(
      genericPage.locator('input[name="work-authorized"][value="yes"]'),
    ).toBeChecked();
    await expect(genericPage.locator("#updates")).toBeChecked();
    await expect(genericPage.locator("#react-name")).toHaveValue("Avery");
    expect(
      await genericPage
        .locator("#shadow-host")
        .evaluate(
          (host: HTMLElement) =>
            host.shadowRoot?.querySelector<HTMLInputElement>(
              "#shadow-portfolio",
            )?.value,
        ),
    ).toBe("https://portfolio.example.test/avery");
    expect(
      await genericPage
        .locator("#resume")
        .evaluate((input: HTMLInputElement) => input.files?.[0]?.name),
    ).toBe(attachment.displayName);
    expect(
      await genericPage
        .locator("#cover-letter")
        .evaluate((input: HTMLInputElement) => input.files?.length),
    ).toBe(0);
    expect(
      await genericPage
        .locator("#transcript")
        .evaluate((input: HTMLInputElement) => input.files?.length),
    ).toBe(0);
    expect(await genericPage.evaluate(() => window.location.pathname)).toBe(
      "/generic",
    );
    expect(
      await genericPage.evaluate(() => window.fixtureEvents.reactObserved),
    ).toBeGreaterThan(0);
  });

  test("undo restores only extension writes and clears the extension-attached resume", async () => {
    const tabId = await targetTabId(worker, genericPage.url());
    const result = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.undo",
    });
    expect(
      result.undo.outcomes.filter(
        (outcome: any) => outcome.status === "restored",
      ).length,
    ).toBeGreaterThanOrEqual(8);
    await expect(genericPage.locator("#full-name")).toHaveValue("");
    await expect(genericPage.locator("#email")).toHaveValue("");
    await expect(genericPage.locator("#country")).toHaveValue("");
    expect(
      await genericPage
        .locator("#resume")
        .evaluate((input: HTMLInputElement) => input.files?.length),
    ).toBe(0);
    await expect(genericPage.locator("#salary")).toHaveValue("");
    await expect(genericPage.locator("#eeo")).toHaveValue("");
  });

  test("selects every ATS adapter and fills ordinary fake fixture fields", async () => {
    test.setTimeout(60_000);
    const expectedFamilies = [
      "greenhouse",
      "lever",
      "ashby",
      "smartrecruiters",
      "workday",
      "icims",
      "taleo",
    ];
    for (const family of expectedFamilies) {
      const page = await context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/${family}`, {
        waitUntil: "domcontentloaded",
      });

      const tabId = await targetTabId(worker, page.url());
      const result = await sendToRuntime(worker, tabId, {
        type: "jobseek.page.v3.fill",
        context: {
          profile,
          settings: {
            preserveExisting: true,
            authorizationAutofillEnabled: true,
          },
        },
      });
      expect(result.inspection.siteFamily).toBe(family);
      await expect(page.locator("#full-name")).toHaveValue("Avery Fixture");
      await expect(page.locator("#email")).toHaveValue(
        "avery.fixture@example.test",
      );
      await page.close();
    }
  });

  test("fills exact reviewed Cisco-style SmartRecruiters disclosures only", async () => {
    const page = await context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/smartrecruiters`, {
      waitUntil: "domcontentloaded",
    });
    const tabId = await targetTabId(worker, page.url());
    const answers = [
      {
        id: "gender",
        normalizedQuestion: "please select your gender",
        fieldType: "select",
        answer: "Man",
        scopeType: "global",
        sensitivity: "manual",
        confirmed: true,
        active: true,
      },
      {
        id: "race",
        normalizedQuestion: "please select your race ethnicity",
        fieldType: "select",
        answer: "Asian (United States of America)",
        scopeType: "global",
        sensitivity: "manual",
        confirmed: true,
        active: true,
      },
      {
        id: "veteran",
        normalizedQuestion: "please select your veteran status",
        fieldType: "select",
        answer: "I am not a veteran",
        scopeType: "global",
        sensitivity: "manual",
        confirmed: true,
        active: true,
      },
      {
        id: "government",
        normalizedQuestion:
          "are you currently or previously appointed as a u s government official or employed by a u s government or foreign government entity in any capacity",
        fieldType: "select",
        answer: "No",
        scopeType: "global",
        sensitivity: "ordinary",
        confirmed: true,
        active: true,
      },
      {
        id: "government-family",
        normalizedQuestion:
          "do you have a family relationship biological adopted marriage domestic partnership civil union or some other arrangement with or are you a close personal contact a regular and ongoing close connection that may be personal romantic financial or any other type of relationship that could be perceived as more than general acquaintance of u s government or foreign government official",
        fieldType: "select",
        answer: "No",
        scopeType: "global",
        sensitivity: "ordinary",
        confirmed: true,
        active: true,
      },
    ] as const;
    const result = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.fill",
      context: {
        answers,
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: false,
        },
      },
    });
    expect(
      result.outcomes.filter((outcome: any) => outcome.status === "failed"),
    ).toHaveLength(0);
    await expect(page.locator("#sr-gender")).toHaveValue("man");
    await expect(page.locator("#sr-race")).toHaveValue("asian-us");
    await expect(page.locator("#sr-veteran")).toHaveValue("not-veteran");
    await expect(page.locator("#sr-government")).toHaveValue("no");
    await expect(page.locator("#sr-government-family")).toHaveValue("no");
    await expect(page.locator("#sr-certify")).not.toBeChecked();
    expect(await page.evaluate(() => window.fixtureEvents.clicks)).toBe(0);

    await sendToRuntime(worker, tabId, { type: "jobseek.page.v3.undo" });
    await expect(page.locator("#sr-gender")).toHaveValue("");
    await expect(page.locator("#sr-race")).toHaveValue("");
    await expect(page.locator("#sr-veteran")).toHaveValue("");
    await expect(page.locator("#sr-government")).toHaveValue("");
    await expect(page.locator("#sr-government-family")).toHaveValue("");
    await page.close();
  });

  test("selects scoped Ashby and Lever dynamic locations without Enter and guards undo", async () => {
    test.setTimeout(60_000);
    for (const family of ["ashby", "lever"]) {
      const page = await context.newPage();
      await page.goto(`${FIXTURE_ORIGIN}/${family}`, {
        waitUntil: "domcontentloaded",
      });
      const tabId = await targetTabId(worker, page.url());
      const filled = await sendExtensionCommand(context, worker, tabId, {
        type: "jobseek.command.fill",
        context: {
          profile,
          settings: {
            preserveExisting: true,
            authorizationAutofillEnabled: true,
          },
        },
      });
      const input =
        family === "ashby"
          ? page.locator("#ashby-location")
          : page.locator("#location-input");
      await expect(input).toHaveValue("Seattle, Washington, United States");
      expect(
        filled.outcomes.some(
          (outcome: any) =>
            outcome.status === "filled" && outcome.reason === "fill.combobox",
        ),
      ).toBe(true);
      expect(
        filled.inspection.descriptors.some(
          (descriptor: any) => descriptor.elementId === "ashby-resume-parser",
        ),
      ).toBe(false);
      if (family === "ashby") {
        expect(
          filled.inspection.descriptors.find(
            (descriptor: any) => descriptor.elementId === "ashby-start-date",
          )?.promptText,
        ).toBe("When can you start a new role?");
      } else {
        expect(
          filled.inspection.classifications.find((classification: any) => {
            const descriptor = filled.inspection.descriptors.find(
              (candidate: any) =>
                candidate.ref === classification.ref &&
                candidate.elementId === "source",
            );
            return Boolean(descriptor);
          })?.kind,
        ).not.toBe("links.linkedin");
      }
      expect(await page.evaluate(() => window.fixtureEvents)).toMatchObject({
        dynamicOptionMouseDown: 1,
        unrelatedOptionMouseDown: 0,
        enter: 0,
        clicks: 0,
        navigation: 0,
      });

      await sendExtensionCommand(context, worker, tabId, {
        type: "jobseek.command.undo",
      });
      await expect(input).toHaveValue("");
      if (family === "lever") {
        await expect(page.locator("#selected-location")).toHaveValue("");

        await sendExtensionCommand(context, worker, tabId, {
          type: "jobseek.command.fill",
          context: {
            profile,
            settings: {
              preserveExisting: true,
              authorizationAutofillEnabled: true,
            },
          },
        });
        await page.evaluate(() => {
          const location =
            document.querySelector<HTMLInputElement>("#location-input");
          const hidden =
            document.querySelector<HTMLInputElement>("#selected-location");
          if (location) location.value = "Portland, Oregon, United States";
          if (hidden)
            hidden.value = '{"name":"Portland, Oregon, United States"}';
        });
        const guarded = await sendExtensionCommand(context, worker, tabId, {
          type: "jobseek.command.undo",
        });
        await expect(input).toHaveValue("Portland, Oregon, United States");
        await expect(page.locator("#selected-location")).toHaveValue(
          '{"name":"Portland, Oregon, United States"}',
        );
        expect(
          guarded.undo.outcomes.some(
            (outcome: any) =>
              outcome.status === "unsupported" &&
              outcome.reason === "undo.user_changed",
          ),
        ).toBe(true);
      }
      await page.close();
    }
  });

  test("inspects and fills a permitted cross-origin Greenhouse iframe", async () => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`${FIXTURE_ORIGIN}/embedded-greenhouse`, {
      waitUntil: "domcontentloaded",
    });
    const tabId = await targetTabId(worker, page.url());
    const inspected = await sendExtensionCommand(context, worker, tabId, {
      type: "jobseek.command.inspect",
      context: {
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: false,
        },
      },
    });
    expect(inspected.inspection.siteFamily).toBe("greenhouse");
    expect(
      inspected.inspection.descriptors.some(
        (field: any) => field.elementId === "first_name",
      ),
    ).toBe(true);

    const filled = await sendExtensionCommand(context, worker, tabId, {
      type: "jobseek.command.fill",
      context: {
        profile: {
          facts: [
            {
              path: "name.first",
              value: "Avery",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "name.last",
              value: "Fixture",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "contact.email",
              value: "avery.fixture@example.test",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "contact.phone",
              value: "+1 555 010 1010",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "address.city",
              value: "Seattle",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "address.country",
              value: "United States",
              sensitivity: "ordinary",
              fillPolicy: "auto",
              confirmed: true,
            },
            {
              path: "authorization.work_authorized",
              value: "Yes",
              sensitivity: "authorization",
              fillPolicy: "auto",
              confirmed: true,
            },
          ],
        },
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: true,
        },
      },
    });
    expect(
      filled.outcomes.filter((outcome: any) => outcome.status === "failed"),
    ).toHaveLength(0);
    const frame = page.frameLocator("#greenhouse-embed");
    await expect(frame.locator("#first_name")).toHaveValue("Avery");
    await expect(frame.locator("#last_name")).toHaveValue("Fixture");
    await expect(frame.locator("#email")).toHaveValue(
      "avery.fixture@example.test",
    );
    await expect(frame.locator("#country").locator("xpath=..")).toContainText(
      "United States",
    );
    await expect(frame.locator("#phone")).toHaveValue("+1 555-010-1010");
    await expect(
      frame
        .locator(".select-shell")
        .filter({ has: frame.locator("#candidate-location") })
        .locator(".select__single-value"),
    ).toHaveText("Seattle, Washington, United States");
    await expect(frame.locator("#candidate-location")).toHaveValue("");
    const cityDescriptor = filled.inspection.descriptors.find(
      (descriptor: any) => descriptor.elementId === "candidate-location",
    );
    expect(
      filled.outcomes.find(
        (outcome: any) => outcome.ref === cityDescriptor?.ref,
      ),
    ).toMatchObject({
      status: "filled",
      reason: "fill.combobox",
      readBack: "Seattle, Washington, United States",
    });
    expect(
      await frame.locator("body").evaluate(() => window.fixtureEvents),
    ).toMatchObject({
      clicks: 0,
      locationSelections: 1,
    });
    await expect(
      frame.locator("#work_authorized").locator("xpath=.."),
    ).toContainText("Yes");
    expect(
      await frame.locator("body").evaluate(() => window.fixtureEvents.clicks),
    ).toBe(0);

    await sendExtensionCommand(context, worker, tabId, {
      type: "jobseek.command.undo",
    });
    await expect(frame.locator("#candidate-location")).toHaveValue("");
    await expect(
      frame
        .locator(".select-shell")
        .filter({ has: frame.locator("#candidate-location") })
        .locator(".select__single-value"),
    ).toHaveText("");
    await expect(
      frame.locator("#work_authorized").locator("xpath=.."),
    ).not.toContainText("Yes");
    await page.close();
  });

  test("handles open shadow DOM and keeps frames, traps, and extension networking safe", async () => {
    await genericPage
      .frameLocator("#same-origin-frame")
      .locator("#frame-phone")
      .waitFor();
    const tabId = await targetTabId(worker, genericPage.url());
    const topInspection = await sendToRuntime(worker, tabId, {
      type: "jobseek.page.v3.inspect",
      context: {
        profile,
        settings: {
          preserveExisting: true,
          authorizationAutofillEnabled: false,
        },
      },
    });
    expect(
      topInspection.inspection.descriptors.some(
        (field: any) => field.elementId === "frame-phone",
      ),
    ).toBe(true);
    expect(
      topInspection.inspection.diagnostics.some(
        (diagnostic: any) => diagnostic.code === "frame.cross_origin",
      ),
    ).toBe(true);
    const frames = await worker.evaluate(
      async ({ id, pageContext }) => {
        const injections = await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: true },
          files: ["/page-runtime.js"],
        });
        return Promise.all(
          injections.map(async ({ frameId }) => {
            try {
              return {
                frameId,
                response: await chrome.tabs.sendMessage(
                  id,
                  {
                    type: "jobseek.page.v3.inspect",
                    context: pageContext,
                  },
                  { frameId },
                ),
              };
            } catch (error) {
              return { frameId, error: String(error) };
            }
          }),
        );
      },
      {
        id: tabId,
        pageContext: {
          profile,
          settings: {
            preserveExisting: true,
            authorizationAutofillEnabled: false,
          },
        },
      },
    );
    expect(
      frames.some((frame: any) =>
        frame.response?.inspection?.descriptors?.some(
          (field: any) => field.elementId === "frame-phone",
        ),
      ),
    ).toBe(true);
    expect(
      await genericPage.evaluate(() => window.fixtureEvents),
    ).toMatchObject({
      clicks: 0,
      input: 0,
      change: 0,
      navigation: 0,
    });
    const unexpected = requests.filter((url) => {
      const parsed = new URL(url);
      return (
        ![
          FIXTURE_ORIGIN,
          FIXTURE_FRAME_ORIGIN,
          "chrome-extension:",
          "data:",
          "about:",
        ].includes(parsed.origin) && !url.startsWith("chrome-extension:")
      );
    });
    expect(unexpected).toEqual([]);
  });

  test("opens the companion-independent options dashboard in a full tab with all sections", async () => {
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`, {
      waitUntil: "domcontentloaded",
    });
    await expect(options.getByRole("tab")).toHaveCount(8);
    await expect(options.getByRole("tab", { name: "Profile" })).toBeVisible();
    await expect(options.getByRole("tab", { name: "Settings" })).toBeVisible();
    expect(new URL(options.url()).pathname).toBe("/options.html");
    await options.close();
  });

  test("connects to the installed native host on Edge Stable", async () => {
    test.skip(
      process.env.JOBSEEK_EXPECT_NATIVE !== "1",
      "Real native messaging is an Edge-only acceptance check.",
    );
    const response = await worker.evaluate(
      () =>
        new Promise<any>((resolve, reject) => {
          const port = chrome.runtime.connectNative("com.jobseek.assistant");
          const timeout = setTimeout(() => {
            port.disconnect();
            reject(new Error("Native host health timed out."));
          }, 10_000);
          port.onMessage.addListener((message) => {
            clearTimeout(timeout);
            port.disconnect();
            resolve(message);
          });
          port.onDisconnect.addListener(() => {
            if (chrome.runtime.lastError) {
              clearTimeout(timeout);
              reject(new Error(chrome.runtime.lastError.message));
            }
          });
          port.postMessage({
            protocolVersion: 1,
            requestId: "34343434-3434-4434-8434-343434343434",
            operation: "health.get",
            payload: {},
          });
        }),
    );
    expect(response).toMatchObject({
      ok: true,
      requestId: "34343434-3434-4434-8434-343434343434",
      result: { service: "JobSeek.Agent" },
    });
  });
});
