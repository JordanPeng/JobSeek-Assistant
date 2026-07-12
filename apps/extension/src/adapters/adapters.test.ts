import { beforeEach, describe, expect, it } from "vitest";

import { dedicatedAdapters, selectAdapter } from "./index";
import type { AtsFamily, DetectionContext } from "./types";

function ctx(hostname: string, html: string): DetectionContext {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = html;
  return { hostname, href: `https://${hostname}/apply`, document: doc };
}

interface Case {
  readonly family: AtsFamily;
  readonly hostname: string;
  readonly html: string;
}

const CASES: readonly Case[] = [
  {
    family: "greenhouse",
    hostname: "boards.greenhouse.io",
    html: '<div id="grnhse_app"></div>',
  },
  {
    family: "lever",
    hostname: "jobs.lever.co",
    html: '<div class="application-form"></div>',
  },
  {
    family: "workday",
    hostname: "acme.myworkdayjobs.com",
    html: '<div data-automation-id="jobApplicationPage"></div>',
  },
  {
    family: "ashby",
    hostname: "jobs.ashbyhq.com",
    html: '<div class="_ashby_root"></div>',
  },
  {
    family: "smartrecruiters",
    hostname: "jobs.smartrecruiters.com",
    html: '<div data-test="job"></div>',
  },
  {
    family: "icims",
    hostname: "careers-acme.icims.com",
    html: '<div id="icims_content"></div>',
  },
  {
    family: "taleo",
    hostname: "acme.taleo.net",
    html: '<form name="dform"></form>',
  },
];

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("adapter selection", () => {
  it.each(CASES)(
    "selects the $family adapter by host + DOM fingerprint",
    (testCase) => {
      const selection = selectAdapter(ctx(testCase.hostname, testCase.html));
      expect(selection.adapter.family).toBe(testCase.family);
      expect(selection.detection.matched).toBe(true);
      expect(selection.detection.confidence).toBeGreaterThan(0.5);
    },
  );

  it("exposes exactly seven dedicated adapters", () => {
    expect(dedicatedAdapters.map((a) => a.family)).toEqual([
      "greenhouse",
      "lever",
      "ashby",
      "smartrecruiters",
      "workday",
      "icims",
      "taleo",
    ]);
  });

  it("falls back to the generic adapter for unknown sites", () => {
    const selection = selectAdapter(
      ctx("careers.some-company.com", "<form></form>"),
    );
    expect(selection.adapter.family).toBe("generic");
  });

  it("does not let the generic adapter shadow a dedicated match on a page that also has a plain form", () => {
    const selection = selectAdapter(
      ctx("boards.greenhouse.io", '<form></form><div id="grnhse_app"></div>'),
    );
    expect(selection.adapter.family).toBe("greenhouse");
  });

  it("matches on host alone even without DOM markers", () => {
    const selection = selectAdapter(ctx("jobs.lever.co", "<div></div>"));
    expect(selection.adapter.family).toBe("lever");
    expect(selection.detection.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("produces only redacted signal codes, never user values", () => {
    const selection = selectAdapter(
      ctx("jobs.lever.co", '<div class="application-form">Jane Doe</div>'),
    );
    for (const signal of selection.detection.signals) {
      expect(signal).toMatch(/^(host|dom:|generic:)/);
      expect(signal).not.toContain("Jane");
    }
  });
});

describe("adapter hints", () => {
  it("lever contributes data-qa aliases", () => {
    const el = document.createElement("input");
    el.setAttribute("data-qa", "email-input");
    const lever = dedicatedAdapters.find((a) => a.family === "lever");
    expect(lever?.aliasFor?.(el)).toEqual(["email-input"]);
  });

  it("lever extracts the question label and marks its validated location widget dynamic", () => {
    document.body.innerHTML = `
      <label>
        <div class="application-label"><div class="text">Current location</div></div>
        <div class="application-field">
          <input class="location-input" data-qa="location-input" name="location">
          <input type="hidden" id="selected-location">
        </div>
      </label>
    `;
    const input = document.querySelector("input.location-input");
    const lever = dedicatedAdapters.find((a) => a.family === "lever");
    expect(input).not.toBeNull();
    if (!input) throw new Error("Location input fixture missing.");
    expect(lever?.promptHint?.(input)).toBe("Current location");
    expect(lever?.isCombobox?.(input)).toBe(true);
    expect(lever?.comboboxStrategy?.(input)).toBe("dynamic-options");
  });

  it("lever keeps checkbox-group prompts distinct by option", () => {
    document.body.innerHTML = `
      <div>
        <div class="application-label"><div class="text">Language Skill(s)</div></div>
        <div class="application-field">
          <label><input id="english" type="checkbox"><span class="application-answer-alternative">English (ENG)</span></label>
        </div>
      </div>
    `;
    const lever = dedicatedAdapters.find((a) => a.family === "lever");
    expect(
      lever?.promptHint?.(document.getElementById("english") as Element),
    ).toBe("Language Skill(s) - English (ENG)");
  });

  it("ashby reads stable question titles and ignores its convenience resume parser", () => {
    document.body.innerHTML = `
      <div class="ashby-application-form-autofill-input-root">
        <input id="parser" type="file">
      </div>
      <div class="ashby-application-form-field-entry">
        <label class="ashby-application-form-question-title">Where are you currently located?</label>
        <input id="location" role="combobox" aria-autocomplete="list">
      </div>
    `;
    const ashby = dedicatedAdapters.find((a) => a.family === "ashby");
    const parser = document.getElementById("parser");
    const location = document.getElementById("location");
    expect(ashby?.ignoreControl?.(parser as Element)).toBe(true);
    expect(ashby?.promptHint?.(location as Element)).toBe(
      "Where are you currently located?",
    );
    expect(ashby?.comboboxStrategy?.(location as Element)).toBe(
      "dynamic-options",
    );
  });

  it("workday flags a listbox-popup button as a combobox", () => {
    const el = document.createElement("button");
    el.setAttribute("aria-haspopup", "listbox");
    const workday = dedicatedAdapters.find((a) => a.family === "workday");
    expect(workday?.isCombobox?.(el)).toBe(true);
  });

  it("greenhouse safely inspects SVG className objects", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "select2-icon");
    const greenhouse = dedicatedAdapters.find(
      (adapter) => adapter.family === "greenhouse",
    );

    expect(() => greenhouse?.isCombobox?.(svg)).not.toThrow();
    expect(greenhouse?.isCombobox?.(svg)).toBe(true);
  });

  it("greenhouse marks an empty async React Select as dynamic", () => {
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.className = "select__input";
    input.setAttribute("data-jobseek-options", "[]");
    const greenhouse = dedicatedAdapters.find(
      (adapter) => adapter.family === "greenhouse",
    );
    expect(greenhouse?.comboboxStrategy?.(input)).toBe("dynamic-options");
  });
});
