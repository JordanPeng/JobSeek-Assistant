import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  RotateCcw,
  Search,
  Settings,
  WandSparkles,
} from "lucide-react";

import type { InspectionResult } from "../../src/autofill";
import {
  saveDashboardTab,
  saveLastInspection,
} from "../../src/data/inspection-storage";
import { ensureApplicationFramePermissions } from "../../src/data/frame-permissions";
import { isNativeErrorCode, nativeApi } from "../../src/data/native-api";
import type {
  CommandResponse,
  ExtensionCommand,
  PageFillResponse,
  PageInspectResponse,
  PageUndoResponse,
} from "../../src/runtime/messages";
import {
  conservativeApplicationDraft,
  loadPopupDataContext,
} from "./data-context";

type ConnectionState = "checking" | "connected" | "disconnected";
type BusyAction = "inspect" | "fill" | "undo" | "record" | null;
interface ApplicationDraft {
  company: string;
  title: string;
  jobUrl: string;
  jobId: string;
  location: string;
  atsFamily: string;
}

async function sendCommand(command: ExtensionCommand): Promise<unknown> {
  const response: CommandResponse = await browser.runtime.sendMessage(command);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}
function resultInspection(value: unknown): InspectionResult {
  if (!value || typeof value !== "object" || !("inspection" in value))
    throw new Error("The page returned an invalid inspection result.");
  return (value as PageInspectResponse | PageFillResponse).inspection;
}

export function PopupApp() {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [hasReviewedData, setHasReviewedData] = useState(false);
  const [message, setMessage] = useState("Ready for an explicit page action.");
  const [showRecord, setShowRecord] = useState(false);
  const [draft, setDraft] = useState<ApplicationDraft>({
    company: "",
    title: "",
    jobUrl: "",
    jobId: "",
    location: "",
    atsFamily: "",
  });

  const checkHealth = useCallback(async () => {
    setConnection("checking");
    try {
      await sendCommand({ type: "jobseek.command.health" });
      setConnection("connected");
    } catch {
      setConnection("disconnected");
    }
  }, []);
  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  const run = useCallback(
    async (action: Exclude<BusyAction, null | "record">) => {
      setBusy(action);
      try {
        const frameAccess = await ensureApplicationFramePermissions();
        if (!frameAccess.granted) {
          throw new Error(
            "Allow access to the embedded ATS form, then try again.",
          );
        }
        if (action === "inspect" || action === "fill") {
          const data = await loadPopupDataContext({
            includeResumeDocument: action === "fill",
          });
          setHasReviewedData(data.hasReviewedData);
          const result =
            action === "inspect"
              ? await sendCommand({
                  type: "jobseek.command.inspect",
                  context: data.context,
                })
              : await sendCommand({
                  type: "jobseek.command.fill",
                  context: data.context,
                });
          const nextInspection = resultInspection(result);
          setInspection(nextInspection);
          await saveLastInspection(nextInspection);
          if (action === "inspect")
            setMessage("Page inspected. Nothing was changed.");
          else {
            const filled = (result as PageFillResponse).outcomes.filter(
              (outcome) => outcome.status === "filled",
            ).length;
            const generation = (
              result as PageFillResponse & {
                aiGeneration?: {
                  model?: string;
                  generatedCount: number;
                  unresolvedCount: number;
                };
              }
            ).aiGeneration;
            setMessage(
              generation
                ? `AI generated ${String(generation.generatedCount)}; ${String(generation.unresolvedCount)} still need input${generation.model ? `; model ${generation.model}` : ""}.`
                : data.hasReviewedData
                  ? `Filled ${String(filled)} reviewed field${filled === 1 ? "" : "s"}.`
                  : "Page inspected, but no reviewed companion profile or answers were available to fill.",
            );
          }
        } else {
          const result = (await sendCommand({
            type: "jobseek.command.undo",
          })) as PageUndoResponse;
          const restored = result.undo.outcomes.filter(
            (outcome) => outcome.status === "restored",
          ).length;
          setMessage(
            `Restored ${String(restored)} field${restored === 1 ? "" : "s"}.`,
          );
        }
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : "The action failed.",
        );
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  const openRecord = async (): Promise<void> => {
    const [active] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    const initial = conservativeApplicationDraft(active);
    setDraft({
      ...initial,
      jobId: "",
      location: "",
      atsFamily: inspection?.siteFamily ?? "",
    });
    setShowRecord(true);
  };
  const saveRecord = async (): Promise<void> => {
    if (!draft.company.trim() || !draft.title.trim()) {
      setMessage("Review and enter both company and title before saving.");
      return;
    }
    setBusy("record");
    try {
      await nativeApi.applicationsCreate({
        company: draft.company.trim(),
        title: draft.title.trim(),
        jobUrl: draft.jobUrl.trim() || null,
        jobId: draft.jobId.trim() || null,
        location: draft.location.trim() || null,
        atsFamily: draft.atsFamily.trim() || null,
        notes: null,
        status: "saved",
        source: "popup-review",
      });
      setShowRecord(false);
      setMessage(
        "Application recorded as saved. Filling a page never marks it applied.",
      );
    } catch (error) {
      setMessage(
        isNativeErrorCode(error, "duplicate_application")
          ? "A matching job URL or ID already exists. Review it in Applications; nothing was merged."
          : error instanceof Error
            ? error.message
            : "Could not save application.",
      );
    } finally {
      setBusy(null);
    }
  };
  const counts = useMemo(
    () => [
      ["Fill", inspection?.summary.filled ?? 0],
      ["Suggest", inspection?.summary.suggested ?? 0],
      ["Blocked", inspection?.summary.blocked ?? 0],
      ["Unknown", inspection?.summary.skipped ?? 0],
      ["Unsupported", inspection?.summary.unsupported ?? 0],
    ],
    [inspection],
  );

  return (
    <main className="popup">
      <header>
        <div>
          <h1>JobSeek Assistant</h1>
          <p>{inspection?.siteFamily ?? "Current page"}</p>
        </div>
        <button
          className="icon-button"
          title="Open dashboard and settings"
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          <Settings aria-hidden="true" size={18} />
          <span className="sr-only">Open dashboard and settings</span>
        </button>
      </header>
      <button
        className={`connection ${connection}`}
        type="button"
        onClick={() => void checkHealth()}
      >
        <span aria-hidden="true" className="connection-dot" />
        {connection === "connected"
          ? "Companion connected"
          : connection === "checking"
            ? "Checking companion"
            : "Companion unavailable"}
      </button>
      <section className="counts" aria-label="Inspection summary">
        {counts.map(([label, count]) => (
          <div key={label}>
            <strong>{count}</strong>
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section className="actions">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("inspect")}
        >
          <Search aria-hidden="true" size={17} />
          {busy === "inspect" ? "Inspecting…" : "Inspect Page"}
        </button>
        <button
          className="primary"
          type="button"
          disabled={busy !== null}
          onClick={() => void run("fill")}
        >
          <WandSparkles aria-hidden="true" size={17} />
          {busy === "fill" ? "Filling…" : "Fill Current Page"}
        </button>
        <button
          type="button"
          disabled={busy !== null || inspection === null}
          onClick={() => {
            void saveDashboardTab("Answers");
            void browser.runtime.openOptionsPage();
          }}
        >
          <ClipboardCheck aria-hidden="true" size={17} />
          Review Suggestions
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void run("undo")}
        >
          <RotateCcw aria-hidden="true" size={17} />
          {busy === "undo" ? "Undoing…" : "Undo This Fill"}
        </button>
        <button
          type="button"
          className="full-action"
          disabled={busy !== null}
          onClick={() => void openRecord()}
        >
          Record Application
        </button>
      </section>
      {showRecord && (
        <section className="record-form" aria-label="Record application review">
          <h2>Record application</h2>
          <p>
            Review this separately from filling. It will save status{" "}
            <strong>saved</strong> only.
          </p>
          {(
            [
              "company",
              "title",
              "jobUrl",
              "jobId",
              "location",
              "atsFamily",
            ] as const
          ).map((key) => (
            <label key={key}>
              {key}
              <input
                value={draft[key]}
                onChange={(event) =>
                  setDraft({ ...draft, [key]: event.target.value })
                }
              />
            </label>
          ))}
          <div>
            <button
              type="button"
              className="primary"
              disabled={busy !== null}
              onClick={() => void saveRecord()}
            >
              Save reviewed record
            </button>
            <button type="button" onClick={() => setShowRecord(false)}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <p className="status" role="status">
        {message}
        {inspection && !hasReviewedData
          ? " Add reviewed profile facts or answers in the dashboard before filling."
          : ""}
      </p>
    </main>
  );
}
