import { describe, expect, it } from "vitest";

import { createResumeDraft } from "./resume-draft";

describe("createResumeDraft", () => {
  it("proposes only clearly present contact facts and an unconfirmed name", () => {
    const draft = createResumeDraft(`
      Avery Example
      avery@example.test | +1 (555) 010-0101
      https://www.linkedin.com/in/avery-example https://github.com/avery-example
      Education: Example University
      Senior Software Engineer, Example Co.
    `);

    expect(draft.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "name.full",
          value: "Avery Example",
          confirmed: false,
        }),
        expect.objectContaining({
          path: "contact.email",
          value: "avery@example.test",
          confirmed: false,
        }),
        expect.objectContaining({
          path: "contact.phone",
          value: "+1 (555) 010-0101",
          confirmed: false,
        }),
        expect.objectContaining({ path: "links.linkedin", confirmed: false }),
        expect.objectContaining({ path: "links.github", confirmed: false }),
      ]),
    );
    expect(draft.proposals.map((item) => item.path)).not.toContain(
      "education.school",
    );
    expect(draft.proposals.map((item) => item.path)).not.toContain(
      "work.title",
    );
    expect(draft.reviewNotes).toEqual(
      expect.arrayContaining([expect.stringContaining("Education")]),
    );
  });

  it("does not mistake headings or prose for a name", () => {
    const draft = createResumeDraft(
      "PROFESSIONAL EXPERIENCE\nBuilt systems for a team.\n",
    );

    expect(draft.proposals).toEqual([]);
  });
});
