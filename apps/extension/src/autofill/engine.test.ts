import { beforeEach, describe, expect, it } from "vitest";

import { executeFill, inspectPage, undoFill } from "./index";
import type { InspectContext, ProfileSnapshot } from "./types";

const profile: ProfileSnapshot = {
  facts: [
    {
      path: "name.first",
      value: "Jane",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
    {
      path: "contact.email",
      value: "jane@example.com",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
  ],
};

const ctx: InspectContext = {
  location: {
    hostname: "jobs.example.com",
    href: "https://jobs.example.com/apply",
  },
  profile,
};

beforeEach(() => {
  document.body.innerHTML = "";
});

function buildForm(): {
  submit: HTMLButtonElement;
  next: HTMLButtonElement;
  events: string[];
} {
  const form = document.createElement("form");
  form.innerHTML = `
    <label for="fn">First Name</label>
    <input id="fn" name="first_name" autocomplete="given-name" />
    <label for="em">Email</label>
    <input id="em" type="email" name="email" />
    <label for="gd">Gender</label>
    <select id="gd" name="gender"><option>Male</option><option>Female</option></select>
    <button type="submit">Submit Application</button>
    <button type="button" id="next">Next</button>
  `;
  document.body.appendChild(form);
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  const next = form.querySelector<HTMLButtonElement>("#next");
  if (!submit || !next) {
    throw new Error("expected submit and next buttons");
  }
  const events: string[] = [];
  for (const btn of [submit, next]) {
    for (const type of ["click", "input", "change"]) {
      btn.addEventListener(type, () =>
        events.push(`${btn.textContent}:${type}`),
      );
    }
  }
  return { submit, next, events };
}

describe("inspectPage → executeFill → undoFill", () => {
  it("fills ordinary facts, blocks sensitive fields, and ignores navigation", () => {
    const { events } = buildForm();
    const result = inspectPage(document, ctx);

    // No submit/Next control ever becomes a descriptor.
    expect(
      result.descriptors.some((d) =>
        d.promptText.toLowerCase().includes("submit"),
      ),
    ).toBe(false);
    expect(result.summary.filled).toBeGreaterThanOrEqual(2);
    expect(result.summary.blocked).toBeGreaterThanOrEqual(1);

    const run = executeFill(result.plan);
    const fn = document.querySelector<HTMLInputElement>("#fn");
    const em = document.querySelector<HTMLInputElement>("#em");
    expect(fn?.value).toBe("Jane");
    expect(em?.value).toBe("jane@example.com");

    // Gender remains empty — sensitive fields are blocked, never written.
    expect(document.querySelector<HTMLSelectElement>("#gd")?.value).toBe(
      "Male",
    );

    // The submit and Next buttons received no events whatsoever.
    expect(events).toEqual([]);

    const undo = undoFill(run.session);
    expect(undo.outcomes.every((o) => o.status === "restored")).toBe(true);
    expect(fn?.value).toBe("");
    expect(em?.value).toBe("");
  });

  it("returns a JSON-serializable inspection result", () => {
    buildForm();
    const result = inspectPage(document, ctx);
    expect(() => JSON.stringify(result)).not.toThrow();
    const roundTrip = JSON.parse(JSON.stringify(result)) as typeof result;
    expect(roundTrip.plan.items.length).toBe(result.plan.items.length);
  });
});
