import { beforeEach, describe, expect, it, vi } from "vitest";

import { BindingRegistry } from "./registry";
import { executeFill, __writerInternals } from "./writers";
import { undoFill } from "./undo";
import type { ControlType, FillPlan, PlanItem, PlanValue } from "./types";

function fillItem(
  ref: string,
  controlType: ControlType,
  value: PlanValue,
): PlanItem {
  return {
    ref,
    controlType,
    operation: "fill",
    reason: "fill.ordinary",
    source: "profile",
    value,
  };
}

function planOf(...items: PlanItem[]): FillPlan {
  return { items };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("text writers and readback", () => {
  it("writes a text input, reads back, and dispatches input/change/blur", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const events: string[] = [];
    for (const type of ["input", "change", "blur"]) {
      input.addEventListener(type, () => events.push(type));
    }
    const registry = new BindingRegistry();
    const ref = registry.register(input);
    const { outcomes } = executeFill(
      planOf(fillItem(ref, "text", { text: "Jane" })),
      registry,
    );
    expect(input.value).toBe("Jane");
    expect(outcomes[0]?.status).toBe("filled");
    expect(outcomes[0]?.readBack).toBe("Jane");
    expect(events).toEqual(["input", "change", "blur"]);
  });

  it("reports failed when read-back does not match (unsupported control)", () => {
    const div = document.createElement("div");
    div.setAttribute("role", "listbox");
    document.body.appendChild(div);
    const registry = new BindingRegistry();
    const ref = registry.register(div);
    const { outcomes } = executeFill(
      planOf(fillItem(ref, "listbox", { selected: "nope" })),
      registry,
    );
    expect(outcomes[0]?.status).toBe("unsupported");
  });

  it("accepts phone punctuation formatting during read-back", () => {
    const input = document.createElement("input");
    input.type = "tel";
    input.addEventListener("input", () => {
      input.value = "+1 555-010-1010";
    });
    document.body.appendChild(input);
    const registry = new BindingRegistry();
    const ref = registry.register(input);

    const { outcomes } = executeFill(
      planOf(fillItem(ref, "tel", { text: "+1 555 010 1010" })),
      registry,
    );

    expect(outcomes[0]?.status).toBe("filled");
    expect(outcomes[0]?.readBack).toBe("+1 555-010-1010");
  });
});

describe("React-style native setter", () => {
  it("writes through the native prototype value setter", () => {
    const input = document.createElement("input");
    const setSpy = vi.spyOn(HTMLInputElement.prototype, "value", "set");
    __writerInternals.setNativeValue(input, "typed");
    expect(setSpy).toHaveBeenCalledWith("typed");
    expect(input.value).toBe("typed");
  });

  it("bypasses an instance-level (React-controlled) value setter", () => {
    const input = document.createElement("input");
    let instanceSetterCalled = false;
    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return "shadowed";
      },
      set() {
        // Simulate React's controlled-input interception.
        instanceSetterCalled = true;
      },
    });
    __writerInternals.setNativeValue(input, "typed");
    expect(instanceSetterCalled).toBe(false);
  });
});

describe("select, radio, and checkbox writers", () => {
  it("selects an option value", () => {
    const select = document.createElement("select");
    select.innerHTML = `<option value="us">US</option><option value="ca">CA</option>`;
    document.body.appendChild(select);
    const registry = new BindingRegistry();
    const ref = registry.register(select);
    const { outcomes } = executeFill(
      planOf(fillItem(ref, "select", { selected: "ca" })),
      registry,
    );
    expect(select.value).toBe("ca");
    expect(outcomes[0]?.status).toBe("filled");
  });

  it("checks the matching radio in a group", () => {
    document.body.innerHTML = `
      <input type="radio" name="g" value="yes" />
      <input type="radio" name="g" value="no" checked />
    `;
    const first =
      document.querySelector<HTMLInputElement>('input[value="yes"]');
    if (!first) {
      throw new Error("missing radio");
    }
    const registry = new BindingRegistry();
    const ref = registry.register(first);
    executeFill(planOf(fillItem(ref, "radio", { selected: "yes" })), registry);
    const checked = document.querySelector<HTMLInputElement>(
      'input[name="g"]:checked',
    );
    expect(checked?.value).toBe("yes");
  });

  it("sets a checkbox checked state", () => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    document.body.appendChild(cb);
    const registry = new BindingRegistry();
    const ref = registry.register(cb);
    executeFill(planOf(fillItem(ref, "checkbox", { checked: true })), registry);
    expect(cb.checked).toBe(true);
  });
});

describe("non-fill operations do not touch the DOM", () => {
  it("records suggest/skip/block/unsupported statuses without writing", () => {
    const input = document.createElement("input");
    input.value = "untouched";
    document.body.appendChild(input);
    const registry = new BindingRegistry();
    const ref = registry.register(input);
    const items: PlanItem[] = [
      {
        ref,
        controlType: "text",
        operation: "block",
        reason: "sensitive.manual",
        source: "none",
      },
    ];
    const { outcomes, session } = executeFill({ items }, registry);
    expect(outcomes[0]?.status).toBe("blocked");
    expect(input.value).toBe("untouched");
    expect(session.records).toHaveLength(0);
  });
});

describe("session undo", () => {
  it("restores only extension-written prior values", () => {
    const written = document.createElement("input");
    written.value = "original";
    const userEdited = document.createElement("input");
    userEdited.value = "user-typed";
    document.body.append(written, userEdited);

    const registry = new BindingRegistry();
    const writtenRef = registry.register(written);
    // userEdited is intentionally NOT part of any plan/session.
    registry.register(userEdited);

    const { session, outcomes } = executeFill(
      planOf(fillItem(writtenRef, "text", { text: "new-value" })),
      registry,
    );
    expect(outcomes[0]?.status).toBe("filled");
    expect(written.value).toBe("new-value");
    expect(session.records).toHaveLength(1);

    const undo = undoFill(session, registry);
    expect(undo.outcomes[0]?.status).toBe("restored");
    expect(written.value).toBe("original");
    // Field the extension never wrote is left exactly as the user left it.
    expect(userEdited.value).toBe("user-typed");
  });

  describe("resume file writer", () => {
    it("attaches a verified PDF through a native file input and undoes only that write", () => {
      const originalFiles = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "files",
      );
      const originalTransfer = globalThis.DataTransfer;
      let stored: FileList = {
        length: 0,
        item: () => null,
      } as unknown as FileList;
      class Transfer {
        public constructor() {
          stored = { length: 0, item: () => null } as unknown as FileList;
        }
        public readonly items = {
          add: (file: File) => {
            stored = {
              0: file,
              length: 1,
              item: (index: number) => (index === 0 ? file : null),
            } as unknown as FileList;
          },
        };
        public get files(): FileList {
          return stored;
        }
      }
      Object.defineProperty(HTMLInputElement.prototype, "files", {
        configurable: true,
        get() {
          return stored;
        },
        set(value: FileList) {
          stored = value;
        },
      });
      Object.defineProperty(globalThis, "DataTransfer", {
        configurable: true,
        value: Transfer,
      });
      try {
        const input = document.createElement("input");
        input.type = "file";
        const submit = document.createElement("button");
        submit.type = "submit";
        const click = vi.spyOn(submit, "click");
        document.body.append(input, submit);
        const events: string[] = [];
        for (const event of ["input", "change", "blur"]) {
          input.addEventListener(event, () => events.push(event));
        }
        const registry = new BindingRegistry();
        const ref = registry.register(input);
        const bytes = new TextEncoder().encode("%PDF-test");
        const attachment = {
          displayName: "resume.pdf",
          mimeType: "application/pdf" as const,
          sizeBytes: bytes.length,
          sha256: "a".repeat(64),
          dataBase64: btoa(String.fromCharCode(...bytes)),
        };
        const { outcomes, session } = executeFill(
          planOf({
            ref,
            controlType: "file",
            operation: "fill",
            source: "none",
            reason: "fill.document.resume",
            value: {
              document: {
                displayName: attachment.displayName,
                mimeType: attachment.mimeType,
                sizeBytes: attachment.sizeBytes,
                sha256: attachment.sha256,
              },
            },
          }),
          registry,
          { resumeAttachment: attachment },
        );
        expect(outcomes[0]?.status).toBe("filled");
        expect(input.files?.[0]?.name).toBe("resume.pdf");
        expect(events).toEqual(["input", "change", "blur"]);
        expect(click).not.toHaveBeenCalled();
        expect(undoFill(session, registry).outcomes[0]?.status).toBe(
          "restored",
        );
        expect(input.files?.length).toBe(0);
      } finally {
        if (originalFiles)
          Object.defineProperty(
            HTMLInputElement.prototype,
            "files",
            originalFiles,
          );
        Object.defineProperty(globalThis, "DataTransfer", {
          configurable: true,
          value: originalTransfer,
        });
      }
    });
  });

  it("restores a radio group to its prior selection", () => {
    document.body.innerHTML = `
      <input type="radio" name="g" value="yes" />
      <input type="radio" name="g" value="no" checked />
    `;
    const yes = document.querySelector<HTMLInputElement>('input[value="yes"]');
    if (!yes) {
      throw new Error("missing radio");
    }
    const registry = new BindingRegistry();
    const ref = registry.register(yes);
    const { session } = executeFill(
      planOf(fillItem(ref, "radio", { selected: "yes" })),
      registry,
    );
    expect(
      document.querySelector<HTMLInputElement>('input[name="g"]:checked')
        ?.value,
    ).toBe("yes");
    undoFill(session, registry);
    expect(
      document.querySelector<HTMLInputElement>('input[name="g"]:checked')
        ?.value,
    ).toBe("no");
  });
});
