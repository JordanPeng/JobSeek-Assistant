import { describe, expect, it } from "vitest";

import {
  applicationFramePermissionPattern,
  applicationFramePermissionPatterns,
} from "./frame-permissions";

describe("application frame permissions", () => {
  it.each([
    [
      "https://job-boards.greenhouse.io/embed/job_app?for=example",
      "https://job-boards.greenhouse.io/*",
    ],
    ["https://jobs.lever.co/example/apply", "https://jobs.lever.co/*"],
    [
      "https://example.myworkdayjobs.com/en-US/job",
      "https://example.myworkdayjobs.com/*",
    ],
  ])("accepts known ATS frame %s", (url, expected) => {
    expect(applicationFramePermissionPattern(url)).toBe(expected);
  });

  it.each([
    "https://insight.adsrvr.org/track",
    "https://example.com/frame",
    "http://job-boards.greenhouse.io/embed/job_app",
    "not a URL",
  ])("rejects unrelated or insecure frame %s", (url) => {
    expect(applicationFramePermissionPattern(url)).toBeNull();
  });

  it("deduplicates requested origins", () => {
    expect(
      applicationFramePermissionPatterns([
        "https://job-boards.greenhouse.io/a",
        "https://job-boards.greenhouse.io/b",
      ]),
    ).toEqual(["https://job-boards.greenhouse.io/*"]);
  });
});
