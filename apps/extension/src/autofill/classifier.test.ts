import { beforeEach, describe, expect, it } from "vitest";

import { classifyField } from "./classifier";
import { extractDescriptors } from "./descriptor";
import { BindingRegistry } from "./registry";
import type {
  AnswerRecord,
  FieldDescriptor,
  ProfileSnapshot,
  ScopeContext,
} from "./types";

function descriptorsFor(html: string): FieldDescriptor[] {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return extractDescriptors(document, {}, new BindingRegistry(), "generic")
    .descriptors;
}

function only(html: string): FieldDescriptor {
  const [first] = descriptorsFor(html);
  return first;
}

const NO_SCOPE: ScopeContext = {};
const NO_ANSWERS: AnswerRecord[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ordinary classification", () => {
  it("classifies an email field and resolves a confirmed profile fact", () => {
    const profile: ProfileSnapshot = {
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
    const field = only(
      `<label for="e">Email Address</label><input id="e" type="email" />`,
    );
    const c = classifyField(field, profile, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("contact.email");
    expect(c.sensitivity).toBe("ordinary");
    expect(c.candidateProfilePath).toBe("contact.email");
    expect(c.action).toBe("fill");
  });

  it("maps preferred first name and current-or-recent company prompts precisely", () => {
    const preferred = only(
      `<label for="preferred">Preferred First Name</label><input id="preferred" />`,
    );
    expect(classifyField(preferred, undefined, NO_ANSWERS, NO_SCOPE).kind).toBe(
      "name.preferred",
    );
    document.body.innerHTML = "";
    const company = only(
      `<label for="company">Please provide the name of your current (or most recent) company</label><input id="company" />`,
    );
    expect(classifyField(company, undefined, NO_ANSWERS, NO_SCOPE).kind).toBe(
      "work.company",
    );
  });

  it("classifies via autocomplete tokens with high confidence", () => {
    const field = only(
      `<input aria-label="Given" autocomplete="given-name" />`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("name.first");
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it("skips an ordinary field when no profile data exists", () => {
    const field = only(`<label for="p">Phone</label><input id="p" />`);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("contact.phone");
    expect(c.action).toBe("skip");
  });

  it("lets the direct Country label outrank an unrelated Phone legend", () => {
    const field = only(`
      <fieldset>
        <legend>Phone</legend>
        <label for="country">Country</label>
        <input id="country" autocomplete="off" />
      </fieldset>
    `);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("address.country");
    expect(c.candidateProfilePath).toBeUndefined();
  });

  it("maps a current-location question to the reviewed city fact", () => {
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
    const field = only(
      `<label for="location">Where are you currently located?</label><input id="location" role="combobox" />`,
    );
    const c = classifyField(field, profile, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("address.city");
    expect(c.candidateProfilePath).toBe("address.city");
    expect(c.action).toBe("fill");
  });

  it("does not let a LinkedIn option redefine an unrelated source question", () => {
    const field = only(`
      <label for="source">How did you hear about this opportunity?</label>
      <select id="source"><option>LinkedIn</option><option>Other</option></select>
    `);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("unknown");
    expect(c.candidateProfilePath).toBeUndefined();
  });

  it("classifies a university selector from its question despite unrelated page evidence", () => {
    const field = only(`
      <h2>Demographic information</h2>
      <label for="school">Which university did you last attend?</label>
      <select id="school"><option>Carnegie Mellon University</option></select>
    `);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("education.school");
    expect(c.sensitivity).toBe("ordinary");
  });

  it("leaves numeric years-of-experience choices for reviewed answers instead of a summary fact", () => {
    const field = only(`
      <label for="years">How many years of relevant post-college work experience do you have?</label>
      <select id="years"><option>0</option><option>1</option><option>2</option></select>
    `);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("question.ordinary");
    expect(c.action).toBe("skip");
  });

  it("fills a numeric experience question only from an exact reviewed answer", () => {
    const field = only(`
      <label for="years">How many years of relevant experience do you have?</label>
      <select id="years"><option>0</option><option>1</option><option>2</option></select>
    `);
    const answers: AnswerRecord[] = [
      {
        id: "experience-years",
        normalizedQuestion: "how many years of relevant experience do you have",
        fieldType: "select",
        answer: "2",
        scopeType: "global",
        sensitivity: "ordinary",
        confirmed: true,
        active: true,
      },
    ];
    const c = classifyField(field, undefined, answers, NO_SCOPE);
    expect(c.kind).toBe("question.ordinary");
    expect(c.candidateAnswerId).toBe("experience-years");
    expect(c.action).toBe("fill");
  });
});

describe("sensitive classification and blocking", () => {
  it("marks demographic questions manual and blocks them by default", () => {
    const field = only(
      `<label for="g">Gender</label><select id="g"><option>Male</option><option>Female</option></select>`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("sensitive.demographics");
    expect(c.sensitivity).toBe("manual");
    expect(c.action).toBe("block");
  });

  it("marks salary questions manual even though they look like ordinary text", () => {
    const field = only(
      `<label for="s">Expected Salary</label><input id="s" />`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("sensitive.salary");
    expect(c.action).toBe("block");
  });

  it("classifies veteran and disability questions as manual", () => {
    const vet = only(
      `<label for="v">Protected Veteran Status</label><input id="v" />`,
    );
    expect(classifyField(vet, undefined, NO_ANSWERS, NO_SCOPE).kind).toBe(
      "sensitive.veteran",
    );
    document.body.innerHTML = "";
    const dis = only(
      `<label for="d">Disability Status</label><input id="d" />`,
    );
    expect(classifyField(dis, undefined, NO_ANSWERS, NO_SCOPE).kind).toBe(
      "sensitive.disability",
    );
  });

  it("keeps security-clearance eligibility manual", () => {
    const field = only(
      `<label for="clearance">Are you eligible to obtain the required security clearance?</label><input id="clearance" />`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("sensitive.legal");
    expect(c.action).toBe("block");
  });

  it.each([
    "U.S. citizen",
    "U.S. permanent resident (Green Card holder)",
    "Individual granted asylum in the U.S.",
    "Ordinarily a resident of Cuba",
  ])("classifies export-control option %s as manual", (label) => {
    const field = only(
      `<label><input type="checkbox" name="export" />${label}</label>`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("sensitive.export_citizenship");
    expect(c.action).toBe("block");
  });

  it("uses choice options only as a fail-closed sensitive safety signal", () => {
    const field = only(`
      <label for="status">Select status</label>
      <select id="status">
        <option>U.S. citizen</option>
        <option>U.S. permanent resident (Green Card holder)</option>
      </select>
    `);
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("sensitive.export_citizenship");
    expect(c.action).toBe("block");
  });

  it("autofills an exact explicitly reviewed demographic choice", () => {
    const field = only(`
      <label for="gender">Please select your gender</label>
      <select id="gender"><option>Man</option><option>Woman</option></select>
    `);
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
    const c = classifyField(field, undefined, answers, NO_SCOPE);
    expect(c.kind).toBe("sensitive.demographics");
    expect(c.action).toBe("fill");
    expect(c.candidateAnswerId).toBe("gender");
  });

  it("keeps consent choices review-only even with an exact answer", () => {
    const field = only(`
      <fieldset><legend>I consent to the privacy policy</legend>
        <label><input type="radio" name="consent" value="Yes">Yes</label>
        <label><input type="radio" name="consent" value="No">No</label>
      </fieldset>
    `);
    const answers: AnswerRecord[] = [
      {
        id: "consent",
        normalizedQuestion: "i consent to the privacy policy",
        fieldType: "radio",
        answer: "Yes",
        scopeType: "global",
        sensitivity: "manual",
        confirmed: true,
        active: true,
      },
    ];
    const c = classifyField(field, undefined, answers, NO_SCOPE);
    expect(c.kind).toBe("sensitive.consent_signature");
    expect(c.action).toBe("block");
  });
});

describe("authorization classification", () => {
  it("classifies sponsorship as authorization and proposes fill when data present", () => {
    const profile: ProfileSnapshot = {
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
    const field = only(
      `<fieldset><legend>Do you now or in the future require sponsorship?</legend>
        <label><input type="radio" name="sp" value="Yes" />Yes</label>
        <label><input type="radio" name="sp" value="No" />No</label>
      </fieldset>`,
    );
    const c = classifyField(field, profile, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("authorization.sponsorship");
    expect(c.sensitivity).toBe("authorization");
    expect(c.candidateProfilePath).toBe("authorization.sponsorship");
    expect(c.action).toBe("fill");
  });
});

describe("unknown classification", () => {
  it("flags unmapped questions as unknown for review", () => {
    const field = only(
      `<label for="fc">What is your favourite colour?</label><input id="fc" />`,
    );
    const c = classifyField(field, undefined, NO_ANSWERS, NO_SCOPE);
    expect(c.kind).toBe("unknown");
    expect(c.action).toBe("skip");
    expect(c.matchQuality).toBe("none");
  });

  it("does not fill an option-label-only choice prompt from an answer match", () => {
    const field = only(`
      <label><input type="radio" name="q" value="Yes">Yes</label>
      <label><input type="radio" name="q" value="No">No</label>
    `);
    const answers: AnswerRecord[] = [
      {
        id: "unsafe-option-prompt",
        normalizedQuestion: "yes",
        fieldType: "radio",
        answer: "Yes",
        scopeType: "global",
        sensitivity: "ordinary",
        confirmed: true,
        active: true,
      },
    ];
    const c = classifyField(field, undefined, answers, NO_SCOPE);
    expect(c.kind).toBe("unknown");
    expect(c.action).toBe("skip");
    expect(c.candidateAnswerId).toBeUndefined();
  });

  describe("resume file classification", () => {
    it("recognizes only clearly labelled resume/CV file inputs", () => {
      const resume = only(
        `<label for="r">Upload résumé / CV</label><input id="r" type="file" />`,
      );
      expect(
        classifyField(resume, undefined, NO_ANSWERS, NO_SCOPE),
      ).toMatchObject({
        kind: "document.resume",
        sensitivity: "ordinary",
        confidence: 0.98,
      });
      document.body.innerHTML = "";
      const cover = only(
        `<label for="c">Cover letter</label><input id="c" type="file" />`,
      );
      expect(
        classifyField(cover, undefined, NO_ANSWERS, NO_SCOPE).kind,
      ).not.toBe("document.resume");
      document.body.innerHTML = "";
      const transcript = only(
        `<label for="t">Transcript</label><input id="t" type="file" />`,
      );
      expect(
        classifyField(transcript, undefined, NO_ANSWERS, NO_SCOPE).kind,
      ).not.toBe("document.resume");
      document.body.innerHTML = "";
      const generic = only(
        `<label for="f">Upload a file</label><input id="f" type="file" />`,
      );
      expect(
        classifyField(generic, undefined, NO_ANSWERS, NO_SCOPE).kind,
      ).not.toBe("document.resume");
    });
  });
});
