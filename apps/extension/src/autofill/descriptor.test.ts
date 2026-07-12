import { beforeEach, describe, expect, it } from "vitest";

import { extractDescriptors } from "./descriptor";
import { BindingRegistry } from "./registry";
import type { FieldDescriptor, InspectContext } from "./types";

function extract(
  build: (root: HTMLElement) => void,
  ctx: InspectContext = {},
): {
  descriptors: FieldDescriptor[];
  registry: BindingRegistry;
  diagnostics: ReturnType<typeof extractDescriptors>["diagnostics"];
} {
  const container = document.createElement("div");
  build(container);
  document.body.appendChild(container);
  const registry = new BindingRegistry();
  const out = extractDescriptors(document, ctx, registry, "generic");
  return {
    descriptors: out.descriptors,
    diagnostics: out.diagnostics,
    registry,
  };
}

function byPrompt(
  descriptors: FieldDescriptor[],
  prompt: string,
): FieldDescriptor | undefined {
  return descriptors.find((d) => d.promptText === prompt);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("descriptor DOM compatibility", () => {
  it("does not crash on SVGAnimatedString className values", () => {
    document.body.innerHTML = `
      <form id="application_form">
        <svg class="select2-icon" aria-hidden="true"></svg>
        <label>Email <input id="email" type="email"></label>
      </form>
    `;
    const registry = new BindingRegistry();

    const result = extractDescriptors(document, {}, registry, "greenhouse", {
      isCombobox: (element) =>
        (element.getAttribute("class") ?? "").includes("select2"),
    });

    expect(result.descriptors.some((item) => item.elementId === "email")).toBe(
      true,
    );
  });

  it("lets an adapter override a text input with an explicit dynamic combobox strategy", () => {
    document.body.innerHTML = `
      <label>Current location
        <input id="location" class="location-input" type="text">
      </label>
    `;
    const result = extractDescriptors(
      document,
      {},
      new BindingRegistry(),
      "lever",
      {
        isCombobox: (element) => element.id === "location",
        comboboxStrategy: (element) =>
          element.id === "location" ? "dynamic-options" : undefined,
      },
    );
    expect(result.descriptors[0]).toMatchObject({
      elementId: "location",
      controlType: "combobox",
      comboboxStrategy: "dynamic-options",
    });
  });

  it("omits controls explicitly ignored by an adapter", () => {
    document.body.innerHTML = `
      <input id="ignored" type="file">
      <label>Email <input id="email" type="email"></label>
    `;
    const result = extractDescriptors(
      document,
      {},
      new BindingRegistry(),
      "ashby",
      { ignoreControl: (element) => element.id === "ignored" },
    );
    expect(
      result.descriptors.some(
        (descriptor) => descriptor.elementId === "ignored",
      ),
    ).toBe(false);
    expect(
      result.descriptors.some((descriptor) => descriptor.elementId === "email"),
    ).toBe(true);
  });
});

describe("descriptor evidence", () => {
  it("assembles label, name, id, and placeholder evidence", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <label for="fn">First Name</label>
        <input id="fn" name="first_name" placeholder="Jane" autocomplete="given-name" required />
      `;
    });
    const field = byPrompt(descriptors, "First Name");
    expect(field).toBeDefined();
    expect(field?.controlType).toBe("text");
    expect(field?.required).toBe(true);
    expect(field?.autocomplete).toBe("given-name");
    const sources = field?.evidence.map((e) => e.source) ?? [];
    expect(sources).toContain("label");
    expect(sources).toContain("name");
    expect(sources).toContain("id");
    expect(sources).toContain("placeholder");
  });

  it("reads select options and current value", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <label for="c">Country</label>
        <select id="c" name="country">
          <option value="us">United States</option>
          <option value="ca" selected>Canada</option>
        </select>
      `;
    });
    const field = byPrompt(descriptors, "Country");
    expect(field?.controlType).toBe("select");
    expect(field?.options).toHaveLength(2);
    expect(field?.currentValue).toBe("ca");
  });

  it("excludes wrapped select options from the question label", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <label>Please select your gender
          <select id="gender"><option>Man</option><option>Woman</option></select>
        </label>
      `;
    });
    const field = byPrompt(descriptors, "Please select your gender");
    expect(field).toBeDefined();
    expect(field?.options.map((option) => option.label)).toEqual([
      "Man",
      "Woman",
    ]);
  });

  it("reads a MAIN-world annotated React Select value", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <label for="country">Country</label>
        <input id="country" role="combobox" data-jobseek-current-value="United States +1">
      `;
    });
    expect(byPrompt(descriptors, "Country")?.currentValue).toBe(
      "United States +1",
    );
  });
});

describe("descriptor visibility and exclusions", () => {
  it("excludes hidden, disabled, readonly, password, and search controls", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <input name="visible" aria-label="Visible" />
        <input name="disp" aria-label="Display none" style="display:none" />
        <input name="dis" aria-label="Disabled" disabled />
        <input name="ro" aria-label="Readonly" readonly />
        <input type="hidden" name="h" />
        <input type="password" name="pw" aria-label="Password" />
        <input type="search" name="s" aria-label="Search" />
        <input name="q" aria-label="Search query" />
      `;
    });
    const labels = descriptors.map((d) => d.promptText);
    expect(labels).toContain("Visible");
    expect(labels).not.toContain("Display none");
    expect(labels).not.toContain("Disabled");
    expect(labels).not.toContain("Readonly");
    expect(labels).not.toContain("Password");
    expect(labels).not.toContain("Search");
    expect(labels).not.toContain("Search query");
  });

  it("never treats buttons or submit inputs as candidates", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <input name="ok" aria-label="Ok Field" />
        <button type="submit">Submit</button>
        <button>Next</button>
        <input type="submit" value="Apply" />
        <a role="button">Continue</a>
      `;
    });
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.promptText).toBe("Ok Field");
  });

  it("emits a redacted diagnostic for security exclusions without raw values", () => {
    const { diagnostics } = extract((root) => {
      root.innerHTML = `<input type="password" name="pw" aria-label="Password" value="secret" />`;
    });
    const diag = diagnostics.find((d) => d.code === "excluded.password");
    expect(diag).toBeDefined();
    expect(JSON.stringify(diag)).not.toContain("secret");
    expect(diag?.fieldFingerprint).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("descriptor radio grouping", () => {
  it("collapses a radio group into one descriptor with options", () => {
    const { descriptors } = extract((root) => {
      root.innerHTML = `
        <fieldset>
          <legend>Do you require sponsorship?</legend>
          <label><input type="radio" name="spon" value="yes" />Yes</label>
          <label><input type="radio" name="spon" value="no" checked />No</label>
        </fieldset>
      `;
    });
    const radios = descriptors.filter((d) => d.controlType === "radio");
    expect(radios).toHaveLength(1);
    expect(radios[0]?.options).toHaveLength(2);
    expect(radios[0]?.currentValue).toBe("no");
    expect(radios[0]?.legendText).toBe("Do you require sponsorship?");
  });
});

describe("descriptor open shadow root", () => {
  it("recurses open shadow roots and marks shadow context", () => {
    const { descriptors } = extract((root) => {
      const host = document.createElement("div");
      root.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Shadow Email");
      input.setAttribute("type", "email");
      shadow.appendChild(input);
    });
    const field = byPrompt(descriptors, "Shadow Email");
    expect(field).toBeDefined();
    expect(field?.controlType).toBe("email");
    expect(field?.frame.inShadowDom).toBe(true);
    expect(field?.frame.shadowDepth).toBe(1);
  });

  it("does not enter a closed shadow root", () => {
    const { descriptors } = extract((root) => {
      const host = document.createElement("div");
      root.appendChild(host);
      const shadow = host.attachShadow({ mode: "closed" });
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Closed Email");
      shadow.appendChild(input);
    });
    expect(byPrompt(descriptors, "Closed Email")).toBeUndefined();
  });
});

describe("descriptor cross-origin frames", () => {
  it("reports cross-origin frames as unsupported diagnostics instead of accessing", () => {
    const { diagnostics } = extract(
      (root) => {
        root.innerHTML = `<input name="x" aria-label="X" />`;
      },
      {
        crossOriginFrames: [
          { origin: "https://third.example", path: "top>frame[0]" },
        ],
      },
    );
    const diag = diagnostics.find((d) => d.code === "frame.cross_origin");
    expect(diag).toBeDefined();
    expect(diag?.category).toBe("discovery");
  });
});
