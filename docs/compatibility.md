# Compatibility

This matrix describes what the autofill engine and adapters are **designed** to
handle. Unless a row is in the **Manual Edge Stable acceptance** section below,
its results come from **synthetic, original fake fixtures** exercised under
Playwright Chromium — they are not claims about real employer sites.

## Adapter / platform matrix

| Target | Adapter | Field detection | Notes |
| --- | --- | --- | --- |
| Generic (any form) | `generic` | Native controls, labels/`aria`, React-controlled inputs | Default when no ATS is detected |
| Greenhouse | `greenhouse` | Native + custom comboboxes | Synthetic fixture |
| Lever | `lever` | Native + custom widgets | Synthetic fixture |
| Ashby | `ashby` | Native + React-controlled | Synthetic fixture |
| SmartRecruiters | `smartrecruiters` | Native + custom widgets | Synthetic fixture |
| Workday | `workday` | Native + custom comboboxes, dynamic sections | Synthetic fixture; complex widget set |
| iCIMS | `icims` | Native + labeled inputs | Synthetic fixture |
| Taleo | `taleo` | Native + labeled inputs | Synthetic fixture |

## DOM / control support

| Capability | Supported | Notes |
| --- | --- | --- |
| Native inputs / selects / textareas / checkboxes / radios | ✅ | Read-back verified |
| React-controlled inputs | ✅ | Value set via native setters + events |
| Custom comboboxes / listbox widgets | ✅ (best effort) | Adapter-specific matching |
| Dynamic employment / education sections | ✅ | Add-row aware in supported adapters |
| Open shadow DOM | ✅ | Traversed |
| Same-origin iframe | ✅ | The on-demand runtime discovers accessible iframe documents and inspects them with the top page |
| Resume/CV file attachment | ✅ (opt-in) | Only where page controls permit; off by default |
| Cross-origin frame | ❌ | Deliberately inaccessible; only a diagnostic placeholder |
| Closed shadow DOM | ❌ | Not reachable |
| CAPTCHA | ❌ | Never solved or bypassed |
| Auth / login walls | ❌ | Never handled |
| Assessments / coding tests | ❌ | Never completed |

## Sites explicitly deferred

- **LinkedIn** and **Indeed** (including "Easy Apply") are **deferred**. They are
  not supported targets in this version.

## Terminal actions

Submit / Next / Apply / Finish controls are never activated. In the fixtures,
these controls are instrumented to **fail the test if activated**, and no such
activation occurs.

---

## Manual Edge Stable acceptance

> The rows above are synthetic Chromium results. Real acceptance on Microsoft
> Edge Stable with the native host and a real (reviewed) resume is a **separate**
> gate and is **not yet recorded**. Fill this section in only after an actual
> manual run, per the checklist in [`testing.md`](testing.md).

An automated dedicated-profile run on Edge Stable 150.0.4078.48 passed the
eight synthetic fixture checks on 2026-07-10, including the real installed
native-messaging host. This does not replace the manual real-resume/real-site
checks below.

On 2026-07-11, an automated local Edge run against the real Databricks
`Applied AI Engineer, Learning Intelligence` page reached its cross-origin
Greenhouse iframe, inspected 32 application controls, filled six ordinary
fields with fake data, produced zero failed writes, and did not activate
Submit or any export-control/EEO field.

| Scenario | Edge Stable result | Date | Notes |
| --- | --- | --- | --- |
| Load unpacked + native host registered (id `eblebceopnkaakmhgdcdbpdaampoildh`) | _pending_ | | |
| Real resume import + fact review | _pending_ | | |
| Generic form inspect / fill / undo | _pending_ | | |
| Greenhouse (real) | _pending_ | | |
| Lever (real) | _pending_ | | |
| One complex ATS (e.g. Workday) | _pending_ | | |
| Restart Edge + companion; data still user-only | _pending_ | | |
| No terminal submission occurred | _pending_ | | |
| Gmail consent/proposals (if enabled) | _pending_ | | |

Do not submit test applications to real employers.
