import { beforeEach, describe, expect, it } from "vitest";

import { classifyField } from "./classifier";
import { extractDescriptors } from "./descriptor";
import { buildPlan } from "./planner";
import { BindingRegistry } from "./registry";
import type {
  AnswerRecord,
  Classification,
  FieldDescriptor,
  FillPlan,
  FillSettings,
  ProfileSnapshot,
} from "./types";

interface PlanArgs {
  readonly profile?: ProfileSnapshot;
  readonly answers?: AnswerRecord[];
  readonly settings?: FillSettings;
  readonly resumeDocument?: {
    displayName: string;
    mimeType: "application/pdf";
    sizeBytes: number;
    sha256: string;
  };
  readonly existingFile?: boolean;
}

const DEFAULT_SETTINGS: FillSettings = {
  authorizationAutofillEnabled: false,
  preserveExisting: true,
};

function plan(
  html: string,
  args: PlanArgs = {},
): { plan: FillPlan; descriptors: FieldDescriptor[] } {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const extracted = extractDescriptors(
    document,
    {},
    new BindingRegistry(),
    "generic",
  ).descriptors;
  const descriptors = args.existingFile
    ? extracted.map((descriptor) =>
        descriptor.controlType === "file"
          ? { ...descriptor, currentValue: "already.pdf" }
          : descriptor,
      )
    : extracted;
  const answers = args.answers ?? [];
  const classifications: Classification[] = descriptors.map((d) =>
    classifyField(d, args.profile, answers, {}),
  );
  const built = buildPlan({
    descriptors,
    classifications,
    settings: args.settings ?? DEFAULT_SETTINGS,
    ...(args.profile ? { profile: args.profile } : {}),
    ...(args.answers ? { answers: args.answers } : {}),
    ...(args.resumeDocument ? { resumeDocument: args.resumeDocument } : {}),
  });

  return { plan: built, descriptors };
}

const emailProfile: ProfileSnapshot = {
  facts: [
    {
      path: "contact.email",
      value: "jane@example.com",
      sensitivity: "ordinary",
      fillPolicy: "auto",
      confirmed: true,
    },
  ],
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("planner preservation", () => {
  it("preserves an existing non-empty value by default", () => {
    const { plan: p } = plan(
      `<label for="e">Email</label><input id="e" type="email" value="old@x.com" />`,
      { profile: emailProfile },
    );
    const item = p.items[0];
    expect(item.operation).toBe("skip");
    expect(item.reason).toBe("preserve.existing");
  });

  it("fills an empty ordinary field from a confirmed profile fact", () => {
    const { plan: p } = plan(
      `<label for="e">Email</label><input id="e" type="email" />`,
      {
        profile: emailProfile,
      },
    );
    const item = p.items[0];
    expect(item.operation).toBe("fill");
    expect(item.value?.text).toBe("jane@example.com");
    expect(item.source).toBe("profile");
  });

  it("passes reviewed text to an adapter-declared dynamic combobox", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <label for="location">Current location</label>
      <input id="location" role="combobox">
    `;
    document.body.appendChild(container);
    const extracted = extractDescriptors(
      document,
      {},
      new BindingRegistry(),
      "lever",
      {
        comboboxStrategy: (element) =>
          element.id === "location" ? "dynamic-options" : undefined,
      },
    ).descriptors;
    const descriptors = extracted.map((descriptor) => ({
      ...descriptor,
      comboboxStrategy: "dynamic-options" as const,
    }));
    const profile: ProfileSnapshot = {
      facts: [
        {
          path: "address.city",
          value: "Seattle",
          sensitivity: "ordinary",
          fillPolicy: "auto",
          confirmed: true,
        },
      ],
    };
    const classifications = descriptors.map((descriptor) =>
      classifyField(descriptor, profile, [], {}),
    );
    const built = buildPlan({
      descriptors,
      classifications,
      profile,
      settings: DEFAULT_SETTINGS,
    });
    expect(built.items[0]).toMatchObject({
      operation: "fill",
      value: { text: "Seattle" },
    });
  });

  it("selects a unique expanded live option for a reviewed profile value", () => {
    const profile: ProfileSnapshot = {
      facts: [
        {
          path: "address.country",
          value: "United States",
          sensitivity: "ordinary",
          fillPolicy: "auto",
          confirmed: true,
        },
      ],
    };
    const { plan: p } = plan(
      `<label for="country">Country</label><select id="country"><option value="" selected>Choose</option><option value="us">United States +1</option><option value="ca">Canada +1</option></select>`,
      { profile },
    );
    expect(p.items[0]).toMatchObject({
      operation: "fill",
      value: { selected: "us" },
    });
  });

  it("does not guess between multiple expanded options", () => {
    const profile: ProfileSnapshot = {
      facts: [
        {
          path: "education.school",
          value: "Carnegie Mellon University",
          sensitivity: "ordinary",
          fillPolicy: "auto",
          confirmed: true,
        },
      ],
    };
    const { plan: p } = plan(
      `<label for="school">University</label><select id="school"><option value="" selected>Choose</option><option>Carnegie Mellon University - Pittsburgh</option><option>Carnegie Mellon University - Silicon Valley</option></select>`,
      { profile },
    );
    expect(p.items[0]).toMatchObject({
      operation: "skip",
      reason: "no.matching_option",
    });
  });
});

describe("planner authorization gating", () => {
  const authProfile: ProfileSnapshot = {
    facts: [
      {
        path: "authorization.sponsorship",
        value: "No",
        sensitivity: "authorization",
        fillPolicy: "auto",
        confirmed: true,
      },
    ],
  };
  const html = `<fieldset><legend>Do you require sponsorship?</legend>
      <label><input type="radio" name="sp" value="Yes" />Yes</label>
      <label><input type="radio" name="sp" value="No" />No</label>
    </fieldset>`;

  it("does not autofill authorization when the master setting is disabled", () => {
    const { plan: p } = plan(html, {
      profile: authProfile,
      settings: { authorizationAutofillEnabled: false, preserveExisting: true },
    });
    const item = p.items.find((i) => i.controlType === "radio");
    expect(item?.operation).toBe("suggest");
    expect(item?.reason).toBe("authorization.not_enabled");
  });

  it("autofills authorization only when enabled and the fact policy is auto", () => {
    const { plan: p } = plan(html, {
      profile: authProfile,
      settings: { authorizationAutofillEnabled: true, preserveExisting: true },
    });
    const item = p.items.find((i) => i.controlType === "radio");
    expect(item?.operation).toBe("fill");
    expect(item?.value?.selected).toBe("No");
  });
});

describe("planner manual and unknown handling", () => {
  it("never auto-writes a manual sensitive field", () => {
    const { plan: p } = plan(
      `<label for="g">Gender</label><select id="g"><option>Male</option><option>Female</option></select>`,
    );
    const item = p.items[0];
    expect(item.operation).toBe("block");
    expect(item.reason).toBe("sensitive.manual");
  });

  describe("resume planning", () => {
    const resumeDocument = {
      displayName: "resume.pdf" as const,
      mimeType: "application/pdf" as const,
      sizeBytes: 10,
      sha256: "a".repeat(64),
    };

    it("plans a recognized empty resume input only with document metadata", () => {
      const html = `<label for="r">Upload resume</label><input id="r" type="file" />`;
      expect(plan(html).plan.items[0]).toMatchObject({
        operation: "suggest",
        reason: "document.resume_unavailable",
      });
      document.body.innerHTML = "";
      expect(plan(html, { resumeDocument }).plan.items[0]).toMatchObject({
        operation: "fill",
        value: { document: resumeDocument },
      });
    });

    it("never replaces an existing file selection", () => {
      const { plan: p } = plan(
        `<label for="r">Resume</label><input id="r" type="file" />`,
        { resumeDocument, existingFile: true },
      );
      expect(p.items[0]).toMatchObject({
        operation: "skip",
        reason: "preserve.existing",
      });
    });
  });

  it("flags an unknown field for review", () => {
    const { plan: p } = plan(
      `<label for="fc">Favourite colour</label><input id="fc" />`,
    );
    const item = p.items[0];
    expect(item.operation).toBe("skip");
    expect(item.reason).toBe("review.unknown");
  });

  it("does not coerce unrelated text into an unchecked checkbox", () => {
    const profile: ProfileSnapshot = {
      facts: [
        {
          path: "address.country",
          value: "United States",
          sensitivity: "ordinary",
          fillPolicy: "auto",
          confirmed: true,
        },
      ],
    };
    const { plan: p } = plan(
      `<label><input type="checkbox" name="country" />Country</label>`,
      { profile },
    );
    expect(p.items[0]).toMatchObject({
      operation: "skip",
      reason: "no.matching_option",
    });
  });

  it("offers a saved manual answer as a suggestion, never a fill", () => {
    const answers: AnswerRecord[] = [
      {
        id: "sal",
        normalizedQuestion: "expected salary",
        fieldType: "text",
        answer: "150000",
        scopeType: "global",
        sensitivity: "manual",
        confirmed: true,
        active: true,
      },
    ];
    const { plan: p } = plan(
      `<label for="s">Expected Salary</label><input id="s" />`,
      {
        answers,
      },
    );
    const item = p.items[0];
    expect(item.operation).toBe("suggest");
    expect(item.value?.text).toBe("150000");
  });

  it("fills an exact reviewed demographic selection", () => {
    const answers: AnswerRecord[] = [
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
    ];
    const { plan: p } = plan(
      `<label for="gender">Please select your gender</label><select id="gender"><option value="" selected>Please Select</option><option value="man">Man</option><option value="woman">Woman</option></select>`,
      { answers },
    );
    expect(p.items[0]).toMatchObject({
      operation: "fill",
      value: { selected: "man" },
    });
  });

  it("rejects duplicate matching options for reviewed sensitive data", () => {
    const answers: AnswerRecord[] = [
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
    ];
    const { plan: p } = plan(
      `<label for="gender">Please select your gender</label><select id="gender"><option value="" selected>Please Select</option><option value="man-1">Man</option><option value="man-2">Man</option></select>`,
      { answers },
    );
    expect(p.items[0]).toMatchObject({
      operation: "skip",
      reason: "no.matching_option",
    });
  });

  it("does not write reviewed sensitive text into a dynamic combobox", () => {
    const answers: AnswerRecord[] = [
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
    ];
    document.body.innerHTML = `
      <label for="gender">Please select your gender</label>
      <input id="gender" role="combobox">
    `;
    const descriptors = extractDescriptors(
      document,
      {},
      new BindingRegistry(),
      "smartrecruiters",
      {
        comboboxStrategy: (element) =>
          element.id === "gender" ? "dynamic-options" : undefined,
      },
    ).descriptors;
    const classifications = descriptors.map((descriptor) =>
      classifyField(descriptor, undefined, answers, {}),
    );
    const built = buildPlan({
      descriptors,
      classifications,
      answers,
      settings: DEFAULT_SETTINGS,
    });
    expect(built.items[0]).toMatchObject({
      operation: "skip",
      reason: "no.matching_option",
    });
  });
});
