import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlarmClock,
  Check,
  ChevronRight,
  ExternalLink,
  FileUp,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  clearReviewedApplicationDraft,
  loadDashboardTab,
  loadLastInspection,
  loadReviewedApplicationDraft,
  saveDashboardTab,
  saveReviewedApplicationDraft,
  type DashboardTab,
  type ReviewedApplicationDraft,
  type StoredInspection,
} from "../../src/data/inspection-storage";
import {
  isNativeErrorCode,
  nativeApi,
  type BackupListEntry,
  type BackupPreview,
  type DataDeletionCategory,
  type GmailStatus,
  type CopilotStatus,
  type NativeApplicationEvent,
  type NativeAuditRecord,
  type NativeDiagnostic,
  type NativeProposal,
} from "../../src/data/native-api";
import { toProtocolFieldType } from "../../src/data/answer-control-type";
import { uploadPdf } from "../../src/data/pdf-upload";
import {
  loadSettings,
  saveSettings,
  type LocalSettings,
} from "../../src/data/settings";
import {
  addEntry as addPreparationEntry,
  createStoragePreparationStore,
  listEntries as listPreparationEntries,
  originPatternForUrl,
  PreparationQueueCorruptionError,
  removeEntry as removePreparationEntry,
  requeueEntry as requeuePreparationEntry,
  type PreparationEntry,
} from "../../src/data/preparation-queue";
import type {
  CommandResponse,
  ExtensionCommand,
  PreparationRunResponse,
} from "../../src/runtime/messages";
import {
  createResumeDraft,
  type ResumeFactProposal,
} from "../../src/profile/resume-draft";
import type {
  Answer,
  Application,
  Document,
  ProfileFact,
} from "../../src/native/protocol";

const preparationStore = createStoragePreparationStore();
const EMPTY_PREP_FORM = {
  url: "",
  company: "",
  title: "",
  jobId: "",
  location: "",
  atsFamily: "",
};
type PrepForm = typeof EMPTY_PREP_FORM;

async function sendCommand(command: ExtensionCommand): Promise<unknown> {
  const response: CommandResponse = await browser.runtime.sendMessage(command);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

const TABS: readonly DashboardTab[] = [
  "Profile",
  "Answers",
  "Documents",
  "Applications",
  "Inbox Updates",
  "Activity",
  "Diagnostics",
  "Settings",
];
const STATUSES = [
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "unknown",
] as const;
const EMPTY_APP = {
  company: "",
  title: "",
  jobUrl: "",
  jobId: "",
  atsFamily: "",
  location: "",
  status: "saved",
  notes: "",
};

type EditableFact = ProfileFact & { id: string; evidence?: string };
type AppForm = typeof EMPTY_APP;

function localError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The requested operation failed.";
}
function nullable(value: string): string | null {
  return value.trim() || null;
}
function factFromProposal(proposal: ResumeFactProposal): EditableFact {
  return {
    id: crypto.randomUUID(),
    path: proposal.path,
    value: proposal.value,
    evidence: proposal.evidence,
    sensitivity: "ordinary",
    fillPolicy: "suggest",
    source: "resume-review",
    confirmed: false,
  };
}
function commonFact(path: string): EditableFact {
  const authorization = path.startsWith("authorization.");
  return {
    id: crypto.randomUUID(),
    path,
    value: "",
    source: "manual-review",
    confirmed: false,
    sensitivity: authorization ? "explicit_opt_in" : "ordinary",
    fillPolicy: authorization ? "suggest" : "autofill",
  };
}
function appToForm(application: Application): AppForm {
  return {
    company: application.company,
    title: application.title,
    jobUrl: application.jobUrl ?? "",
    jobId: application.jobId ?? "",
    atsFamily: application.atsFamily ?? "",
    location: application.location ?? "",
    status: application.currentStatus,
    notes: application.notes ?? "",
  };
}

export function OptionsApp() {
  const [tab, setTab] = useState<DashboardTab>("Profile");
  const [settings, setSettings] = useState<LocalSettings | null>(null);
  const [connected, setConnected] = useState<
    "checking" | "connected" | "unavailable"
  >("checking");
  const [profileFacts, setProfileFacts] = useState<EditableFact[]>([]);
  const [profileMeta, setProfileMeta] = useState<{
    version: number | null;
    createdAt?: string;
    changeSummary?: string;
  }>({ version: null });
  const [history, setHistory] = useState<
    {
      version: number;
      createdAt: string;
      source: string;
      changeSummary: string;
    }[]
  >([]);
  const [answers, setAnswers] = useState<readonly Answer[]>([]);
  const [documents, setDocuments] = useState<readonly Document[]>([]);
  const [applications, setApplications] = useState<readonly Application[]>([]);
  const [events, setEvents] = useState<readonly NativeApplicationEvent[]>([]);
  const [selectedApplication, setSelectedApplication] =
    useState<Application | null>(null);
  const [audit, setAudit] = useState<readonly NativeAuditRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<readonly NativeDiagnostic[]>(
    [],
  );
  const [inspection, setInspection] = useState<StoredInspection | null>(null);
  const [message, setMessage] = useState(
    "Load reviewed local data when the companion is available.",
  );
  const [busy, setBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState<number | null>(null);
  const [pdfPreview, setPdfPreview] = useState("");
  const [deleteDocumentId, setDeleteDocumentId] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState({
    ref: "",
    value: "",
    scopeType: "global",
    scopeValue: "",
    sensitivity: "ordinary",
  });
  const [appForm, setAppForm] = useState<AppForm>(EMPTY_APP);
  const [applicationFilter, setApplicationFilter] = useState("all");
  const [prepEntries, setPrepEntries] = useState<readonly PreparationEntry[]>(
    [],
  );
  const [prepForm, setPrepForm] = useState<PrepForm>(EMPTY_PREP_FORM);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [copilot, setCopilot] = useState<CopilotStatus | null>(null);
  const [proposals, setProposals] = useState<readonly NativeProposal[]>([]);

  const refreshPreparation = useCallback(async () => {
    try {
      setPrepEntries(await listPreparationEntries(preparationStore));
    } catch (error) {
      if (error instanceof PreparationQueueCorruptionError) {
        setPrepEntries([]);
        setMessage(error.message);
      } else {
        setMessage(localError(error));
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await nativeApi.health();
      setConnected("connected");
      const [
        profile,
        profileHistory,
        loadedAnswers,
        loadedDocuments,
        loadedApplications,
        loadedAudit,
        loadedDiagnostics,
        gmailStatus,
        loadedProposals,
        copilotStatus,
      ] = await Promise.all([
        nativeApi.profileGet(),
        nativeApi.profileHistory(),
        nativeApi.answersList(false),
        nativeApi.documentsList(),
        nativeApi.applicationsList(),
        nativeApi.auditList(),
        nativeApi.diagnosticsList(),
        nativeApi.gmailStatus(),
        nativeApi.proposalsList(),
        nativeApi.copilotStatus(),
      ]);
      setProfileFacts(
        profile.facts.map((fact) => ({ ...fact, id: crypto.randomUUID() })),
      );
      setProfileMeta({
        version: profile.version,
        createdAt: profile.createdAt,
        changeSummary: profile.changeSummary,
      });
      setHistory([...profileHistory.versions]);
      setAnswers(loadedAnswers);
      setDocuments(loadedDocuments);
      setApplications(loadedApplications);
      setAudit(loadedAudit);
      setDiagnostics(loadedDiagnostics);
      setGmail(gmailStatus);
      setProposals(loadedProposals);
      setCopilot(copilotStatus);
      setMessage("Reviewed local data refreshed.");
    } catch (error) {
      setConnected("unavailable");
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [savedTab, loadedSettings, storedInspection, storedDraft] =
        await Promise.all([
          loadDashboardTab(),
          loadSettings(),
          loadLastInspection(),
          loadReviewedApplicationDraft(),
        ]);
      setTab(savedTab);
      setSettings(loadedSettings);
      setInspection(storedInspection);
      if (storedDraft) setAppForm({ ...storedDraft, notes: "" });
      await refreshPreparation();
      await refresh();
    })();
  }, [refresh, refreshPreparation]);

  useEffect(() => {
    if (gmail?.state !== "connecting" && gmail?.state !== "syncing") return;
    const timer = window.setInterval(() => {
      void Promise.all([nativeApi.gmailStatus(), nativeApi.proposalsList()])
        .then(([status, next]) => {
          setGmail(status);
          setProposals(next);
        })
        .catch((error: unknown) => setMessage(localError(error)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [gmail?.state]);

  const chooseTab = (next: DashboardTab): void => {
    setTab(next);
    void saveDashboardTab(next);
  };
  const gmailAction = async (
    action: "connect" | "sync" | "disconnect",
  ): Promise<void> => {
    if (
      action === "disconnect" &&
      !window.confirm("Disconnect Gmail and delete the local encrypted token?")
    )
      return;
    try {
      const status =
        action === "connect"
          ? await nativeApi.gmailConnect()
          : action === "sync"
            ? await nativeApi.gmailSync()
            : await nativeApi.gmailDisconnect();
      setGmail(status);
      setMessage(
        action === "connect"
          ? "Gmail connection started in the companion."
          : action === "sync"
            ? "Gmail sync started in the companion."
            : "Gmail was disconnected locally.",
      );
    } catch (error) {
      setMessage(localError(error));
    }
  };
  const reviewProposal = async (
    id: string,
    decision: "accept" | "reject",
  ): Promise<void> => {
    try {
      await nativeApi.proposalsReview(id, decision);
      setProposals(await nativeApi.proposalsList());
      setApplications(await nativeApi.applicationsList());
    } catch (error) {
      setMessage(localError(error));
    }
  };
  const updateFact = (id: string, patch: Partial<EditableFact>): void =>
    setProfileFacts((facts) =>
      facts.map((fact) => (fact.id === id ? { ...fact, ...patch } : fact)),
    );
  const removeFact = (id: string): void =>
    setProfileFacts((facts) => facts.filter((fact) => fact.id !== id));

  const importResume = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setPdfProgress(0);
    try {
      const imported = await uploadPdf(file, ({ uploadedBytes, totalBytes }) =>
        setPdfProgress(Math.round((uploadedBytes / totalBytes) * 100)),
      );
      setPdfPreview(imported.extractedText.slice(0, 2_000));
      const draft = createResumeDraft(imported.extractedText);
      setProfileFacts((facts) => [
        ...facts,
        ...draft.proposals.map(factFromProposal),
      ]);
      setMessage(
        `${String(draft.proposals.length)} facts proposed for review. Nothing was saved to your profile.`,
      );
      setDocuments(await nativeApi.documentsList());
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
      setPdfProgress(null);
    }
  };
  const saveProfile = async (): Promise<void> => {
    if (
      profileFacts.some(
        (fact) => !fact.confirmed || !fact.path.trim() || fact.value === "",
      )
    ) {
      setMessage(
        "Confirm or remove every profile row before saving the reviewed snapshot.",
      );
      return;
    }
    setBusy(true);
    try {
      await nativeApi.profileUpdate(
        profileFacts.map((fact) => ({
          path: fact.path,
          value: fact.value,
          sensitivity: fact.sensitivity,
          fillPolicy: fact.fillPolicy,
          source: fact.source,
          confirmed: fact.confirmed,
        })),
        "Reviewed profile update",
      );
      await refresh();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedSuggestion = useMemo(
    () =>
      inspection?.classifications
        .filter(
          (item) =>
            item.action === "suggest" ||
            item.kind === "question.ordinary" ||
            item.kind === "unknown",
        )
        .map((classification) => ({
          classification,
          descriptor: inspection.descriptors.find(
            (descriptor) => descriptor.ref === classification.ref,
          ),
        }))
        .filter(
          (
            item,
          ): item is {
            classification: StoredInspection["classifications"][number];
            descriptor: StoredInspection["descriptors"][number];
          } => item.descriptor !== undefined,
        ) ?? [],
    [inspection],
  );
  const confirmAnswer = async (): Promise<void> => {
    const candidate = selectedSuggestion.find(
      (item) => item.classification.ref === answerDraft.ref,
    );
    if (!candidate) return;
    const fieldType = toProtocolFieldType(candidate.descriptor.controlType);
    if (!fieldType) {
      setMessage("This control type is unsupported for answer confirmation.");
      return;
    }
    let answer: ProfileFact["value"];
    try {
      answer = JSON.parse(answerDraft.value) as ProfileFact["value"];
    } catch {
      setMessage('Enter a valid JSON answer, such as "Yes" or true.');
      return;
    }
    setBusy(true);
    try {
      await nativeApi.answersConfirm({
        rawQuestion: candidate.descriptor.promptText || "Unlabeled question",
        fieldType,
        options: candidate.descriptor.options.map((option) => option.label),
        answer,
        scopeType: answerDraft.scopeType as "global" | "domain" | "company",
        scopeValue: nullable(answerDraft.scopeValue),
        sensitivity: answerDraft.sensitivity as
          "ordinary" | "explicit_opt_in" | "manual",
        source: "dashboard-review",
      });
      setAnswerDraft({
        ref: "",
        value: "",
        scopeType: "global",
        scopeValue: "",
        sensitivity: "ordinary",
      });
      await refresh();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };
  const updateAnswer = async (
    answer: Answer,
    raw: string,
    active: boolean,
  ): Promise<void> => {
    try {
      const parsed = JSON.parse(raw) as Answer["answer"];
      await nativeApi.answersUpdate({
        id: answer.id,
        answer: parsed,
        active,
        source: "dashboard-review",
      });
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof SyntaxError
          ? "Answer JSON is invalid."
          : localError(error),
      );
    }
  };
  const saveApplication = async (): Promise<void> => {
    if (!appForm.company.trim() || !appForm.title.trim()) {
      setMessage("Company and title are required.");
      return;
    }
    setBusy(true);
    const payload = {
      company: appForm.company.trim(),
      title: appForm.title.trim(),
      jobUrl: nullable(appForm.jobUrl),
      jobId: nullable(appForm.jobId),
      atsFamily: nullable(appForm.atsFamily),
      location: nullable(appForm.location),
      status: appForm.status as (typeof STATUSES)[number],
      notes: nullable(appForm.notes),
      source: "dashboard-review",
    };
    try {
      if (selectedApplication)
        await nativeApi.applicationsUpdate({
          ...payload,
          id: selectedApplication.id,
        });
      else await nativeApi.applicationsCreate(payload);
      setSelectedApplication(null);
      setAppForm(EMPTY_APP);
      await clearReviewedApplicationDraft();
      await refresh();
    } catch (error) {
      setMessage(
        isNativeErrorCode(error, "duplicate_application")
          ? "A matching job URL or ID exists. Review the existing application; nothing was merged."
          : localError(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const selectApplication = async (application: Application): Promise<void> => {
    setSelectedApplication(application);
    setAppForm(appToForm(application));
    try {
      setEvents(await nativeApi.applicationsEvents(application.id));
    } catch (error) {
      setMessage(localError(error));
    }
  };
  const updateApplicationForm = (next: AppForm): void => {
    setAppForm(next);
    void saveReviewedApplicationDraft({
      company: next.company,
      title: next.title,
      jobUrl: next.jobUrl,
      jobId: next.jobId,
      atsFamily: next.atsFamily,
      location: next.location,
      status: next.status as ReviewedApplicationDraft["status"],
    });
  };

  const addPreparation = async (): Promise<void> => {
    if (!originPatternForUrl(prepForm.url)) {
      setMessage("Enter a valid http(s) reviewed form URL.");
      return;
    }
    if (!prepForm.company.trim() || !prepForm.title.trim()) {
      setMessage("Company and title are required for a queued form.");
      return;
    }
    setBusy(true);
    try {
      await addPreparationEntry(
        preparationStore,
        {
          url: prepForm.url.trim(),
          company: prepForm.company.trim(),
          title: prepForm.title.trim(),
          jobId: prepForm.jobId.trim() || undefined,
          location: prepForm.location.trim() || undefined,
          atsFamily: prepForm.atsFamily.trim() || undefined,
        },
        new Date().toISOString(),
      );
      setPrepForm(EMPTY_PREP_FORM);
      await sendCommand({ type: "jobseek.command.preparation.sync" });
      await refreshPreparation();
      setMessage(
        "Reviewed form queued. It never submits, logs in, or handles CAPTCHAs.",
      );
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };
  const grantPreparationPermission = async (
    entry: PreparationEntry,
  ): Promise<void> => {
    const pattern = originPatternForUrl(entry.url);
    if (!pattern) {
      setMessage("This entry has no valid origin to grant.");
      return;
    }
    try {
      const granted = await browser.permissions.request({ origins: [pattern] });
      if (!granted) {
        setMessage(
          "Domain permission was not granted. Nothing runs without it.",
        );
        return;
      }
      if (entry.status === "needs_permission")
        await requeuePreparationEntry(
          preparationStore,
          entry.id,
          new Date().toISOString(),
        );
      await sendCommand({ type: "jobseek.command.preparation.sync" });
      await refreshPreparation();
      setMessage(
        `Granted access to ${pattern}. Preparation may now open this form.`,
      );
    } catch (error) {
      setMessage(localError(error));
    }
  };
  const runPreparationNext = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = (await sendCommand({
        type: "jobseek.command.preparation.runNext",
      })) as PreparationRunResponse;
      const note: Record<PreparationRunResponse["status"], string> = {
        disabled: "Unattended preparation is off. Enable it in Settings.",
        idle: "No pending queued form is ready to prepare.",
        busy: "A queued form is already being prepared. One runs at a time.",
        no_permission: "That form needs a domain permission grant first.",
        opening: "Opening the next queued form in a background tab for review.",
      };
      setMessage(note[result.status]);
      await refreshPreparation();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };
  const removePreparation = async (entry: PreparationEntry): Promise<void> => {
    try {
      const removed = await removePreparationEntry(preparationStore, entry.id);
      if (!removed) {
        setMessage(
          "This entry is being prepared right now and cannot be removed.",
        );
        return;
      }
      await sendCommand({ type: "jobseek.command.preparation.sync" });
      await refreshPreparation();
    } catch (error) {
      setMessage(localError(error));
    }
  };
  const openPreparationTab = async (entry: PreparationEntry): Promise<void> => {
    if (entry.tabId === undefined) return;
    try {
      await browser.tabs.update(entry.tabId, { active: true });
    } catch {
      setMessage("That prepared tab is no longer open.");
      await refreshPreparation();
    }
  };

  return (
    <main className="dashboard">
      <header className="topbar">
        <div>
          <h1>JobSeek Assistant</h1>
          <p>Reviewed local profile and application workspace</p>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh companion data"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw aria-hidden="true" size={17} />
          <span className="sr-only">Refresh data</span>
        </button>
      </header>
      <div className={`connection ${connected}`} role="status">
        <span aria-hidden="true" className="connection-dot" />
        {connected === "connected"
          ? "Companion connected"
          : connected === "checking"
            ? "Checking companion"
            : "Companion unavailable — profile and documents stay in the local companion."}
      </div>
      <div className="workspace">
        <nav aria-label="Dashboard sections" className="tabs" role="tablist">
          {TABS.map((item) => (
            <button
              key={item}
              id={`tab-${item}`}
              role="tab"
              aria-selected={tab === item}
              aria-controls={`panel-${item}`}
              type="button"
              onClick={() => chooseTab(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <section
          className="panel"
          id={`panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
        >
          {tab === "Profile" && (
            <ProfilePanel
              facts={profileFacts}
              meta={profileMeta}
              history={history}
              preview={pdfPreview}
              progress={pdfProgress}
              busy={busy}
              onImport={importResume}
              onAdd={(path) =>
                setProfileFacts((facts) => [...facts, commonFact(path)])
              }
              onUpdate={updateFact}
              onRemove={removeFact}
              onSave={() => void saveProfile()}
            />
          )}
          {tab === "Answers" && (
            <AnswersPanel
              answers={answers}
              suggestions={selectedSuggestion}
              draft={answerDraft}
              onDraft={setAnswerDraft}
              onConfirm={() => void confirmAnswer()}
              onUpdate={(answer, raw, active) =>
                void updateAnswer(answer, raw, active)
              }
              onConfirmGenerated={(id) =>
                void nativeApi
                  .answersConfirmGenerated(id)
                  .then(refresh)
                  .catch((error: unknown) => setMessage(localError(error)))
              }
            />
          )}
          {tab === "Documents" && (
            <DocumentsPanel
              documents={documents}
              deleting={deleteDocumentId}
              onDeleteRequest={setDeleteDocumentId}
              onDelete={() => {
                if (deleteDocumentId)
                  void nativeApi
                    .documentsDelete(deleteDocumentId)
                    .then(refresh)
                    .catch((error: unknown) => setMessage(localError(error)))
                    .finally(() => setDeleteDocumentId(null));
              }}
            />
          )}
          {tab === "Applications" && (
            <>
              <ApplicationsPanel
                applications={applications}
                events={events}
                selected={selectedApplication}
                form={appForm}
                filter={applicationFilter}
                onFilter={setApplicationFilter}
                onSelect={(app) => void selectApplication(app)}
                onNew={() => {
                  setSelectedApplication(null);
                  setAppForm(EMPTY_APP);
                  setEvents([]);
                  void clearReviewedApplicationDraft();
                }}
                onForm={updateApplicationForm}
                onSave={() => void saveApplication()}
              />
              <PreparationQueuePanel
                entries={prepEntries}
                form={prepForm}
                busy={busy}
                onForm={setPrepForm}
                onAdd={() => void addPreparation()}
                onGrant={(entry) => void grantPreparationPermission(entry)}
                onRunNext={() => void runPreparationNext()}
                onRemove={(entry) => void removePreparation(entry)}
                onOpen={(entry) => void openPreparationTab(entry)}
              />
            </>
          )}
          {tab === "Inbox Updates" && (
            <InboxUpdatesPanel
              gmail={gmail}
              proposals={proposals}
              onAction={(action) => void gmailAction(action)}
              onReview={(id, decision) => void reviewProposal(id, decision)}
            />
          )}
          {tab === "Activity" && (
            <ActivityPanel
              records={audit}
              onUndo={(id) =>
                void nativeApi
                  .auditUndo(id)
                  .then(refresh)
                  .catch((error: unknown) => setMessage(localError(error)))
              }
            />
          )}
          {tab === "Diagnostics" && (
            <DiagnosticsPanel diagnostics={diagnostics} />
          )}
          {tab === "Settings" && settings && (
            <>
              <SettingsPanel
                settings={settings}
                copilot={copilot}
                onConfigure={async (enabled, preferredModel) => {
                  const status = await nativeApi.copilotConfigure(
                    enabled,
                    preferredModel,
                  );
                  setCopilot(status);
                }}
                onSave={async (next) => {
                  try {
                    const saved = await saveSettings(next);
                    setSettings(saved);
                    await sendCommand({
                      type: "jobseek.command.preparation.sync",
                    });
                    setMessage("Settings saved locally in this browser.");
                  } catch (error) {
                    setMessage(localError(error));
                  }
                }}
              />
              <DataManagementPanel
                busy={busy}
                setBusy={setBusy}
                setMessage={setMessage}
                onChanged={refresh}
              />
            </>
          )}
        </section>
      </div>
      <p className="status" role="status">
        {message}
      </p>
    </main>
  );
}

function InboxUpdatesPanel(props: {
  gmail: GmailStatus | null;
  proposals: readonly NativeProposal[];
  onAction: (action: "connect" | "sync" | "disconnect") => void;
  onReview: (id: string, decision: "accept" | "reject") => void;
}) {
  const status = props.gmail;
  const connecting =
    status?.state === "connecting" || status?.state === "syncing";
  return (
    <section className="inbox-updates">
      <h2>Inbox Updates</h2>
      <p>
        Gmail is optional. The companion requests exactly{" "}
        <code>https://www.googleapis.com/auth/gmail.readonly</code>; it cannot
        send, modify, delete, label, archive, or trash email.
      </p>
      <p className="warning">
        Google apps in Testing may require reconnecting about every seven days.
        Sync only creates reviewable proposals; it never changes an application
        automatically.
      </p>
      <dl className="gmail-status">
        <div>
          <dt>Status</dt>
          <dd>{status?.state ?? "loading"}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{status?.lastSyncAt ?? "Never"}</dd>
        </div>
        <div>
          <dt>Cursor</dt>
          <dd>{status?.hasCursor ? "Established" : "Not established"}</dd>
        </div>
        {status?.lastErrorCode && (
          <div>
            <dt>Error</dt>
            <dd>{status.lastErrorCode}</dd>
          </div>
        )}
      </dl>
      {!status?.clientConfigured && (
        <p className="warning">
          Install a Desktop OAuth client before connecting Gmail.
        </p>
      )}
      <div className="prep-actions">
        <button
          type="button"
          className="primary"
          disabled={!status?.clientConfigured || connecting}
          onClick={() => props.onAction("connect")}
        >
          {status?.state === "needs_reconnect" ? "Reconnect" : "Connect"}
        </button>
        <button
          type="button"
          disabled={!status?.connected || connecting}
          onClick={() => props.onAction("sync")}
        >
          Sync now
        </button>
        <button
          type="button"
          disabled={!status || status.state === "unconfigured"}
          onClick={() => props.onAction("disconnect")}
        >
          Disconnect
        </button>
      </div>
      <h3>Proposals</h3>
      {props.proposals.length === 0 ? (
        <p>No Gmail status proposals.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Application</th>
              <th>Proposed update</th>
              <th>Evidence</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {props.proposals.map((proposal) => (
              <tr key={proposal.id}>
                <td>
                  {proposal.application.company}
                  <small>
                    {proposal.application.title} · current:{" "}
                    {proposal.application.currentStatus}
                  </small>
                </td>
                <td>
                  {proposal.proposedStatus}
                  <small>
                    {proposal.classifier} ·{" "}
                    {Math.round(proposal.confidence * 100)}% · {proposal.reason}
                  </small>
                </td>
                <td>
                  {proposal.evidence ? (
                    <>
                      {proposal.evidence.senderDomain}
                      <small>{proposal.evidence.receivedAt}</small>
                      <small>{proposal.evidence.subject}</small>
                      <small>{proposal.evidence.snippet}</small>
                    </>
                  ) : (
                    "No retained evidence"
                  )}
                </td>
                <td>
                  {proposal.state === "pending" ? (
                    <span className="prep-actions">
                      <button
                        type="button"
                        onClick={() => props.onReview(proposal.id, "accept")}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        onClick={() => props.onReview(proposal.id, "reject")}
                      >
                        Reject
                      </button>
                    </span>
                  ) : (
                    proposal.state
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ProfilePanel(props: {
  facts: EditableFact[];
  meta: { version: number | null; createdAt?: string; changeSummary?: string };
  history: {
    version: number;
    createdAt: string;
    source: string;
    changeSummary: string;
  }[];
  preview: string;
  progress: number | null;
  busy: boolean;
  onImport: (file: File | undefined) => Promise<void>;
  onAdd: (path: string) => void;
  onUpdate: (id: string, patch: Partial<EditableFact>) => void;
  onRemove: (id: string) => void;
  onSave: () => void;
}) {
  const templates = [
    "name.legal",
    "name.preferred",
    "name.full",
    "name.first",
    "name.last",
    "contact.email",
    "contact.phone",
    "address.line1",
    "address.city",
    "address.state",
    "address.postal",
    "links.linkedin",
    "links.github",
    "links.portfolio",
    "authorization.work_authorized",
    "authorization.sponsorship",
  ];
  return (
    <section>
      <h2>Profile</h2>
      <p>
        Importing a resume only proposes facts. Review and confirm every row
        before saving a complete immutable profile snapshot.
      </p>
      <label className="upload">
        <FileUp aria-hidden="true" size={16} /> Import resume PDF{" "}
        <input
          aria-label="Import resume PDF"
          type="file"
          accept="application/pdf,.pdf"
          disabled={props.busy}
          onChange={(event) => void props.onImport(event.target.files?.[0])}
        />
      </label>
      {props.progress !== null && (
        <progress max="100" value={props.progress}>
          {props.progress}%
        </progress>
      )}
      {props.preview && (
        <details>
          <summary>Extracted-text preview (first 2,000 characters)</summary>
          <pre>{props.preview}</pre>
        </details>
      )}
      <div className="toolbar">
        <label>
          Add common fact{" "}
          <select
            defaultValue=""
            onChange={(event) => {
              if (event.target.value) {
                props.onAdd(event.target.value);
                event.target.value = "";
              }
            }}
          >
            <option value="" disabled>
              Select field
            </option>
            {templates.map((path) => (
              <option key={path}>{path}</option>
            ))}
          </select>
        </label>
        <span>
          Version {props.meta.version ?? "not saved"}{" "}
          {props.meta.createdAt ? `• ${props.meta.createdAt}` : ""}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Value</th>
            <th>Sensitivity</th>
            <th>Fill policy</th>
            <th>Reviewed</th>
            <th>
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {props.facts.map((fact) => (
            <tr key={fact.id}>
              <td>
                <input
                  aria-label="Fact path"
                  value={fact.path}
                  onChange={(event) =>
                    props.onUpdate(fact.id, { path: event.target.value })
                  }
                />
                {fact.evidence && <small>Review required</small>}
              </td>
              <td>
                <input
                  aria-label={`Value for ${fact.path}`}
                  value={
                    typeof fact.value === "string"
                      ? fact.value
                      : JSON.stringify(fact.value)
                  }
                  onChange={(event) =>
                    props.onUpdate(fact.id, { value: event.target.value })
                  }
                />
              </td>
              <td>
                <select
                  aria-label={`Sensitivity for ${fact.path}`}
                  value={fact.sensitivity}
                  onChange={(event) =>
                    props.onUpdate(fact.id, {
                      sensitivity: event.target
                        .value as EditableFact["sensitivity"],
                    })
                  }
                >
                  <option value="ordinary">Ordinary</option>
                  <option value="explicit_opt_in">Explicit opt-in</option>
                  <option value="manual">Manual</option>
                </select>
              </td>
              <td>
                <select
                  aria-label={`Fill policy for ${fact.path}`}
                  value={fact.fillPolicy}
                  onChange={(event) =>
                    props.onUpdate(fact.id, {
                      fillPolicy: event.target
                        .value as EditableFact["fillPolicy"],
                    })
                  }
                >
                  <option value="autofill">Autofill</option>
                  <option value="suggest">Suggest</option>
                  <option value="manual">Manual</option>
                </select>
              </td>
              <td>
                <label>
                  <input
                    type="checkbox"
                    checked={fact.confirmed}
                    onChange={(event) =>
                      props.onUpdate(fact.id, {
                        confirmed: event.target.checked,
                      })
                    }
                  />{" "}
                  Confirm
                </label>
              </td>
              <td>
                <button
                  type="button"
                  title="Remove profile row"
                  className="icon-button"
                  onClick={() => props.onRemove(fact.id)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                  <span className="sr-only">Remove</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="primary"
        onClick={props.onSave}
        disabled={props.busy}
      >
        <Check aria-hidden="true" size={16} /> Save reviewed profile
      </button>
      <h3>Profile history</h3>
      <ul className="history">
        {props.history.map((item) => (
          <li key={item.version}>
            v{item.version} — {item.changeSummary}{" "}
            <small>{item.createdAt}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AnswersPanel(props: {
  answers: readonly Answer[];
  suggestions: {
    classification: StoredInspection["classifications"][number];
    descriptor: StoredInspection["descriptors"][number];
  }[];
  draft: {
    ref: string;
    value: string;
    scopeType: string;
    scopeValue: string;
    sensitivity: string;
  };
  onDraft: (draft: {
    ref: string;
    value: string;
    scopeType: string;
    scopeValue: string;
    sensitivity: string;
  }) => void;
  onConfirm: () => void;
  onUpdate: (answer: Answer, raw: string, active: boolean) => void;
  onConfirmGenerated: (id: string) => void;
}) {
  return (
    <section>
      <h2>Answers</h2>
      <p>
        Exact, confirmed answers only. Save a reviewed answer explicitly;
        unsupported controls cannot be confirmed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Answer JSON</th>
            <th>Scope</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {props.answers.map((answer) => (
            <AnswerRow
              key={answer.id}
              answer={answer}
              onSave={props.onUpdate}
              onConfirmGenerated={props.onConfirmGenerated}
            />
          ))}
        </tbody>
      </table>
      <h3>Last inspection suggestions</h3>
      {props.suggestions.length === 0 ? (
        <p>No stored unknown or suggested questions.</p>
      ) : (
        <div className="review-list">
          {props.suggestions.map(({ classification, descriptor }) => (
            <button
              key={classification.ref}
              type="button"
              className={
                props.draft.ref === classification.ref ? "selected" : ""
              }
              onClick={() =>
                props.onDraft({
                  ...props.draft,
                  ref: classification.ref,
                  value:
                    props.draft.ref === classification.ref
                      ? props.draft.value
                      : '""',
                })
              }
            >
              <ChevronRight aria-hidden="true" size={15} />{" "}
              {descriptor.promptText || "Unlabeled question"}{" "}
              <small>{descriptor.controlType}</small>
            </button>
          ))}
        </div>
      )}
      {props.draft.ref && (
        <div className="form-grid">
          <label>
            Answer JSON
            <textarea
              value={props.draft.value}
              onChange={(event) =>
                props.onDraft({ ...props.draft, value: event.target.value })
              }
            />
          </label>
          <label>
            Scope
            <select
              value={props.draft.scopeType}
              onChange={(event) =>
                props.onDraft({ ...props.draft, scopeType: event.target.value })
              }
            >
              <option>global</option>
              <option>domain</option>
              <option>company</option>
            </select>
          </label>
          <label>
            Scope value
            <input
              value={props.draft.scopeValue}
              onChange={(event) =>
                props.onDraft({
                  ...props.draft,
                  scopeValue: event.target.value,
                })
              }
            />
          </label>
          <label>
            Sensitivity
            <select
              value={props.draft.sensitivity}
              onChange={(event) =>
                props.onDraft({
                  ...props.draft,
                  sensitivity: event.target.value,
                })
              }
            >
              <option value="ordinary">Ordinary</option>
              <option value="explicit_opt_in">Explicit opt-in</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <button type="button" className="primary" onClick={props.onConfirm}>
            Confirm exact answer
          </button>
        </div>
      )}
    </section>
  );
}
function AnswerRow({
  answer,
  onSave,
  onConfirmGenerated,
}: {
  answer: Answer;
  onSave: (answer: Answer, raw: string, active: boolean) => void;
  onConfirmGenerated: (id: string) => void;
}) {
  const [raw, setRaw] = useState(() => JSON.stringify(answer.answer));
  const [active, setActive] = useState(answer.active);
  return (
    <tr>
      <td>
        {answer.rawQuestionExample}
        <small>
          {answer.fieldType} • {answer.sensitivity}
          {answer.source.startsWith("copilot-grounded-draft:")
            ? " • AI Draft"
            : ""}
        </small>
      </td>
      <td>
        <textarea
          aria-label={`Answer JSON for ${answer.rawQuestionExample}`}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
        />
      </td>
      <td>
        {answer.scopeType}
        {answer.scopeValue ? `: ${answer.scopeValue}` : ""}
      </td>
      <td>
        <label>
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />{" "}
          Active
        </label>
        <button type="button" onClick={() => onSave(answer, raw, active)}>
          Save
        </button>
        {answer.source.startsWith("copilot-grounded-draft:") &&
          answer.confirmedAt === null && (
            <button type="button" onClick={() => onConfirmGenerated(answer.id)}>
              Confirm AI draft
            </button>
          )}
      </td>
    </tr>
  );
}
function DocumentsPanel({
  documents,
  deleting,
  onDeleteRequest,
  onDelete,
}: {
  documents: readonly Document[];
  deleting: string | null;
  onDeleteRequest: (id: string | null) => void;
  onDelete: () => void;
}) {
  return (
    <section>
      <h2>Documents</h2>
      <p>
        PDFs are stored only in the companion vault. Import a replacement from
        Profile.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Size</th>
            <th>Hash</th>
            <th>Imported</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id}>
              <td>{document.displayName}</td>
              <td>{document.sizeBytes.toLocaleString()} bytes</td>
              <td>
                <code>{document.sha256.slice(0, 12)}</code>
              </td>
              <td>{document.createdAt}</td>
              <td>
                {deleting === document.id ? (
                  <span>
                    Delete?{" "}
                    <button type="button" onClick={onDelete}>
                      Yes, delete
                    </button>
                    <button type="button" onClick={() => onDeleteRequest(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="icon-button"
                    title="Delete document"
                    onClick={() => onDeleteRequest(document.id)}
                  >
                    <Trash2 aria-hidden="true" size={16} />
                    <span className="sr-only">Delete document</span>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function ApplicationsPanel(props: {
  applications: readonly Application[];
  events: readonly NativeApplicationEvent[];
  selected: Application | null;
  form: AppForm;
  filter: string;
  onFilter: (value: string) => void;
  onSelect: (app: Application) => void;
  onNew: () => void;
  onForm: (form: AppForm) => void;
  onSave: () => void;
}) {
  const visible =
    props.filter === "all"
      ? props.applications
      : props.applications.filter(
          (item) => item.currentStatus === props.filter,
        );
  const set = (name: keyof AppForm, value: string): void =>
    props.onForm({ ...props.form, [name]: value });
  return (
    <section>
      <h2>Applications</h2>
      <p>
        Records are reviewed separately. Filling a page never creates or changes
        an application.
      </p>
      <div className="toolbar">
        <label>
          Status{" "}
          <select
            value={props.filter}
            onChange={(event) => props.onFilter(event.target.value)}
          >
            <option value="all">All</option>
            {STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={props.onNew}>
          <Plus aria-hidden="true" size={16} /> New reviewed record
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Title</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((application) => (
            <tr
              key={application.id}
              className={
                props.selected?.id === application.id ? "selected-row" : ""
              }
              onClick={() => props.onSelect(application)}
            >
              <td>{application.company}</td>
              <td>{application.title}</td>
              <td>{application.currentStatus}</td>
              <td>{application.updatedAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>
        {props.selected ? "Edit reviewed application" : "Record application"}
      </h3>
      <div className="form-grid">
        {(
          [
            "company",
            "title",
            "jobUrl",
            "jobId",
            "location",
            "atsFamily",
          ] as const
        ).map((name) => (
          <label key={name}>
            {name}
            <input
              value={props.form[name]}
              onChange={(event) => set(name, event.target.value)}
            />
          </label>
        ))}
        <label>
          Status
          <select
            value={props.form.status}
            onChange={(event) => set("status", event.target.value)}
          >
            {STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="wide">
          Notes
          <textarea
            value={props.form.notes}
            onChange={(event) => set("notes", event.target.value)}
          />
        </label>
        <button type="button" className="primary" onClick={props.onSave}>
          {props.selected ? "Save reviewed changes" : "Save as reviewed record"}
        </button>
      </div>
      {props.selected && (
        <>
          <h3>Immutable timeline</h3>
          <ol className="timeline">
            {props.events.map((event) => (
              <li key={event.id}>
                {event.eventType}: {event.fromStatus ?? "—"} →{" "}
                {event.toStatus ?? "—"} <small>{event.occurredAt}</small>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
function ActivityPanel({
  records,
  onUndo,
}: {
  records: readonly NativeAuditRecord[];
  onUndo: (id: string) => void;
}) {
  return (
    <section>
      <h2>Activity</h2>
      <p>
        Undo creates compensating history; it never erases the original record.
      </p>
      <table>
        <thead>
          <tr>
            <th>Operation</th>
            <th>Entity</th>
            <th>When</th>
            <th>Undo</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td>{record.operation}</td>
              <td>{record.entityType}</td>
              <td>{record.createdAt}</td>
              <td>
                {record.undoneAt ? (
                  "Already undone"
                ) : (
                  <button type="button" onClick={() => onUndo(record.id)}>
                    Undo if available
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function PreparationQueuePanel(props: {
  entries: readonly PreparationEntry[];
  form: PrepForm;
  busy: boolean;
  onForm: (form: PrepForm) => void;
  onAdd: () => void;
  onGrant: (entry: PreparationEntry) => void;
  onRunNext: () => void;
  onRemove: (entry: PreparationEntry) => void;
  onOpen: (entry: PreparationEntry) => void;
}) {
  const set = (name: keyof PrepForm, value: string): void =>
    props.onForm({ ...props.form, [name]: value });
  const safeToRemove = (entry: PreparationEntry): boolean =>
    !["opening", "waiting_load", "inspecting", "filling"].includes(
      entry.status,
    );
  return (
    <section className="preparation-queue">
      <h2>
        <AlarmClock aria-hidden="true" size={18} /> Preparation queue
      </h2>
      <p className="boundary">
        Opt-in unattended preparation opens each reviewed form in a background
        tab, fills known fields, and records missing questions. It leaves the
        page open for you and{" "}
        <strong>
          never logs in, navigates application steps, submits, or handles
          CAPTCHAs
        </strong>
        . One form is prepared at a time.
      </p>
      <div className="form-grid">
        <label className="wide">
          Reviewed form URL
          <input
            aria-label="Reviewed form URL"
            placeholder="https://…"
            value={props.form.url}
            onChange={(event) => set("url", event.target.value)}
          />
        </label>
        {(["company", "title", "jobId", "location", "atsFamily"] as const).map(
          (name) => (
            <label key={name}>
              {name}
              <input
                aria-label={name}
                value={props.form[name]}
                onChange={(event) => set(name, event.target.value)}
              />
            </label>
          ),
        )}
        <button
          type="button"
          className="primary"
          disabled={props.busy}
          onClick={props.onAdd}
        >
          <Plus aria-hidden="true" size={16} /> Add to queue
        </button>
        <button type="button" disabled={props.busy} onClick={props.onRunNext}>
          <AlarmClock aria-hidden="true" size={16} /> Run next now
        </button>
      </div>
      {props.entries.length === 0 ? (
        <p>No queued reviewed forms.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Company / title</th>
              <th>URL</th>
              <th>Status</th>
              <th>Missing prompts</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  {entry.company}
                  <small>
                    {entry.title}
                    {entry.jobId ? ` • ${entry.jobId}` : ""}
                    {entry.location ? ` • ${entry.location}` : ""}
                    {entry.atsFamily ? ` • ${entry.atsFamily}` : ""}
                  </small>
                </td>
                <td className="prep-url">{entry.url}</td>
                <td>
                  <span className={`prep-status prep-${entry.status}`}>
                    {entry.status}
                  </span>
                  {entry.reason && <small>{entry.reason}</small>}
                </td>
                <td>
                  {entry.missingPrompts && entry.missingPrompts.length > 0 ? (
                    <details>
                      <summary>
                        {entry.missingCounts
                          ? `${String(entry.missingCounts.requiredUnresolved)} required, ${String(entry.missingCounts.blocked + entry.missingCounts.unsupported)} blocked`
                          : String(entry.missingPrompts.length)}
                      </summary>
                      <ul>
                        {entry.missingPrompts.map((prompt, index) => (
                          <li key={index}>{prompt}</li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="prep-actions">
                  <button
                    type="button"
                    title="Grant domain permission"
                    onClick={() => props.onGrant(entry)}
                  >
                    <ShieldCheck aria-hidden="true" size={15} /> Grant domain
                  </button>
                  {entry.tabId !== undefined && (
                    <button
                      type="button"
                      title="Open prepared tab"
                      onClick={() => props.onOpen(entry)}
                    >
                      <ExternalLink aria-hidden="true" size={15} /> Open tab
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove entry"
                    disabled={!safeToRemove(entry)}
                    onClick={() => props.onRemove(entry)}
                  >
                    <Trash2 aria-hidden="true" size={15} />
                    <span className="sr-only">Remove</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
function DiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: readonly NativeDiagnostic[];
}) {
  return (
    <section>
      <h2>Diagnostics</h2>
      <p>
        Redacted diagnostic metadata only; no field values or resume text are
        shown.
      </p>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Site</th>
            <th>Fingerprint</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.map((item) => (
            <tr key={item.id}>
              <td>
                {item.category}/{item.code}
              </td>
              <td>{item.siteFamily ?? "—"}</td>
              <td>{item.fieldFingerprint ?? "—"}</td>
              <td>{item.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
function SettingsPanel({
  settings,
  copilot,
  onConfigure,
  onSave,
}: {
  settings: LocalSettings;
  copilot: CopilotStatus | null;
  onConfigure: (enabled: boolean, preferredModel: string) => Promise<void>;
  onSave: (next: Omit<LocalSettings, "version">) => Promise<void>;
}) {
  const [value, setValue] = useState(settings);
  const [model, setModel] = useState(copilot?.preferredModel ?? "auto");
  const toggle = (
    key:
      | "preserveExisting"
      | "authorizationAutofillEnabled"
      | "resumeAutofillEnabled"
      | "aiEmailClassificationEnabled"
      | "unattendedPreparationEnabled"
      | "applicationAiAnswersEnabled"
      | "applicationAiConsentGranted",
  ): void => setValue({ ...value, [key]: !value[key] });
  return (
    <section>
      <h2>Settings</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.preserveExisting}
          onChange={() => toggle("preserveExisting")}
        />{" "}
        Preserve existing page values
      </label>
      <h3>Grounded application answers</h3>
      <p className="boundary">
        When enabled, your full reviewed profile, extracted active resume text,
        and eligible ordinary application questions/options are sent to GitHub
        Copilot. Sensitive, manual, authorization questions and your answer bank
        are never sent.
      </p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.applicationAiConsentGranted}
          onChange={() => toggle("applicationAiConsentGranted")}
        />{" "}
        I consent to this grounded data transfer.
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.applicationAiAnswersEnabled}
          disabled={!value.applicationAiConsentGranted}
          onChange={() => toggle("applicationAiAnswersEnabled")}
        />{" "}
        Enable grounded application answers
      </label>
      <label>
        Application answer model
        <select
          value={value.applicationAiPreferredModel}
          onChange={(event) =>
            setValue({
              ...value,
              applicationAiPreferredModel: event.target.value,
            })
          }
        >
          <option value="gpt-5.6-luna">GPT-5.6 Luna</option>
          {copilot?.availableModels.map((available) => (
            <option key={available.id} value={available.id}>
              {available.name}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-status">Reasoning effort: high</p>
      <label className="toggle warning">
        <input
          type="checkbox"
          checked={value.authorizationAutofillEnabled}
          onChange={() => toggle("authorizationAutofillEnabled")}
        />{" "}
        Enable reviewed authorization autofill{" "}
        <small>
          Only explicit opt-in authorization facts marked autofill are eligible.
        </small>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.resumeAutofillEnabled}
          onChange={() => toggle("resumeAutofillEnabled")}
        />{" "}
        Attach the active encrypted PDF only to recognized resume/CV file
        inputs; never uploads elsewhere.
      </label>
      <label>
        Preferred model
        <select
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          <option value="auto">Auto</option>
          {copilot?.availableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.aiEmailClassificationEnabled}
          onChange={() => toggle("aiEmailClassificationEnabled")}
        />{" "}
        AI email classification (disabled by default)
        <small>
          Only ambiguous redacted snippets and candidate application metadata
          may be sent to GitHub Copilot. If unavailable, deterministic Gmail
          classification continues.
        </small>
      </label>
      <p className="settings-status">
        Copilot worker:{" "}
        {copilot?.workerInstalled
          ? copilot.runtimeAvailable
            ? "installed"
            : "installed, runtime unavailable"
          : "not installed"}
        {copilot?.lastErrorCode ? ` (${copilot.lastErrorCode})` : ""}
      </p>
      <label className="toggle">
        <input
          type="checkbox"
          checked={value.unattendedPreparationEnabled}
          onChange={() => toggle("unattendedPreparationEnabled")}
        />{" "}
        Unattended preparation{" "}
        <small>
          Fills known fields and leaves pages for review. It never submits, logs
          in, or handles CAPTCHAs.
        </small>
      </label>
      <button
        type="button"
        className="primary"
        onClick={() =>
          void onSave({
            preserveExisting: value.preserveExisting,
            authorizationAutofillEnabled: value.authorizationAutofillEnabled,
            resumeAutofillEnabled: value.resumeAutofillEnabled,
            preferredModel: "auto",
            aiEmailClassificationEnabled: value.aiEmailClassificationEnabled,
            unattendedPreparationEnabled: value.unattendedPreparationEnabled,
            applicationAiAnswersEnabled: value.applicationAiAnswersEnabled,
            applicationAiConsentGranted: value.applicationAiConsentGranted,
            applicationAiPreferredModel: value.applicationAiPreferredModel,
            applicationAiReasoningEffort: "high",
          }).then(async () => {
            await onConfigure(value.aiEmailClassificationEnabled, model);
            await nativeApi.applicationAiConfigure(
              value.applicationAiAnswersEnabled,
              value.applicationAiConsentGranted,
              value.applicationAiPreferredModel,
            );
          })
        }
      >
        Save settings
      </button>
    </section>
  );
}

const DELETION_CATEGORIES: readonly {
  category: DataDeletionCategory;
  label: string;
  description: string;
  token: string;
}[] = [
  {
    category: "profile",
    label: "Profile",
    description: "All profile versions and facts.",
    token: "DELETE PROFILE",
  },
  {
    category: "answers",
    label: "Answers",
    description: "The answer bank and its version history.",
    token: "DELETE ANSWERS",
  },
  {
    category: "documents",
    label: "Documents",
    description: "Document metadata and encrypted vault files.",
    token: "DELETE DOCUMENTS",
  },
  {
    category: "applications",
    label: "Applications",
    description: "Applications, events, evidence, and proposals.",
    token: "DELETE APPLICATIONS",
  },
  {
    category: "gmail_evidence",
    label: "Gmail evidence",
    description:
      "Email evidence, proposals, and sync cursor. Keeps the Gmail connection.",
    token: "DELETE GMAIL EVIDENCE",
  },
  {
    category: "diagnostics",
    label: "Diagnostics",
    description: "Redacted diagnostic records.",
    token: "DELETE DIAGNOSTICS",
  },
  {
    category: "activity",
    label: "Activity",
    description: "The activity and undo history.",
    token: "DELETE ACTIVITY",
  },
  {
    category: "all",
    label: "All local data",
    description:
      "Every category above, plus the Gmail token and Copilot settings. Keeps the OAuth client configuration.",
    token: "DELETE ALL LOCAL DATA",
  },
];

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return "nothing";
  return entries.map(([key, value]) => `${String(value)} ${key}`).join(", ");
}

function DataManagementPanel({
  busy,
  setBusy,
  setMessage,
  onChanged,
}: {
  busy: boolean;
  setBusy: (value: boolean) => void;
  setMessage: (value: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [backups, setBackups] = useState<readonly BackupListEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [restorePassword, setRestorePassword] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState("");
  const [deleteCategory, setDeleteCategory] =
    useState<DataDeletionCategory | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await nativeApi.backupList());
    } catch (error) {
      setMessage(localError(error));
    }
  }, [setMessage]);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  const runExport = async (): Promise<void> => {
    if (exportPassword.length < 12) {
      setMessage("The backup password must be at least 12 characters.");
      return;
    }
    if (exportPassword !== exportConfirm) {
      setMessage("The backup passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await nativeApi.backupExport(
        exportPassword,
        includeDocuments,
      );
      setExportPassword("");
      setExportConfirm("");
      setMessage(
        `Encrypted backup ${result.displayName} created (${formatCounts(result.counts)}).`,
      );
      await refreshBackups();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (): Promise<void> => {
    if (!selectedPath) return;
    setBusy(true);
    setPreview(null);
    setRestoreConfirm("");
    try {
      const result = await nativeApi.backupPreview(
        selectedPath,
        restorePassword,
      );
      setPreview(result);
      setMessage(`Preview ready (${formatCounts(result.counts)}).`);
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };

  const runApply = async (): Promise<void> => {
    if (!selectedPath || !preview || restoreConfirm !== "RESTORE BACKUP")
      return;
    setBusy(true);
    try {
      const result = await nativeApi.backupApply(
        selectedPath,
        restorePassword,
        preview.backupId,
      );
      setPreview(null);
      setRestoreConfirm("");
      setRestorePassword("");
      setMessage(
        `Backup restored (${formatCounts(result.counts)}). Reconnect Gmail to resume email updates.`,
      );
      await onChanged();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async (): Promise<void> => {
    if (!deleteCategory) return;
    const selected = DELETION_CATEGORIES.find(
      (item) => item.category === deleteCategory,
    );
    if (deleteConfirm !== selected?.token) return;
    setBusy(true);
    try {
      const result = await nativeApi.dataDelete(deleteCategory, deleteConfirm);
      setDeleteCategory(null);
      setDeleteConfirm("");
      setMessage(`Deleted ${formatCounts(result.deleted)}.`);
      await onChanged();
      await refreshBackups();
    } catch (error) {
      setMessage(localError(error));
    } finally {
      setBusy(false);
    }
  };

  const activeDelete = DELETION_CATEGORIES.find(
    (item) => item.category === deleteCategory,
  );

  return (
    <>
      <section className="data-backup">
        <h2>Encrypted backup</h2>
        <p className="settings-status">
          Exports are password-encrypted and written to your local backups
          folder. Gmail and GitHub/Copilot tokens are never included; only your
          local JobSeek data is exported.
        </p>
        <div className="backup-block">
          <h3>Create a backup</h3>
          <label>
            Backup password (12+ characters)
            <input
              type="password"
              value={exportPassword}
              autoComplete="new-password"
              onChange={(event) => setExportPassword(event.target.value)}
            />
          </label>
          <label>
            Confirm password
            <input
              type="password"
              value={exportConfirm}
              autoComplete="new-password"
              onChange={(event) => setExportConfirm(event.target.value)}
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={includeDocuments}
              onChange={() => setIncludeDocuments((value) => !value)}
            />{" "}
            Include resume and document files
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void runExport()}
          >
            Export encrypted backup
          </button>
        </div>
        <div className="backup-block">
          <h3>Restore a backup</h3>
          <button
            type="button"
            disabled={busy}
            onClick={() => void refreshBackups()}
          >
            <RefreshCw size={14} /> Refresh backup list
          </button>
          {backups.length === 0 ? (
            <p className="settings-status">No backups found.</p>
          ) : (
            <ul className="backup-list">
              {backups.map((backup) => (
                <li key={backup.path}>
                  <label className="toggle">
                    <input
                      type="radio"
                      name="backup-file"
                      checked={selectedPath === backup.path}
                      onChange={() => {
                        setSelectedPath(backup.path);
                        setPreview(null);
                        setRestoreConfirm("");
                      }}
                    />{" "}
                    {backup.name}{" "}
                    <small>{Math.round(backup.sizeBytes / 1024)} KiB</small>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <label>
            Backup password
            <input
              type="password"
              value={restorePassword}
              autoComplete="off"
              onChange={(event) => setRestorePassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={busy || !selectedPath || restorePassword.length < 12}
            onClick={() => void runPreview()}
          >
            Preview restore
          </button>
          {preview && (
            <div className="backup-preview">
              <p>
                Backup from {preview.exportedAt} (schema v
                {preview.schemaVersion}
                {preview.includesDocuments ? ", with documents" : ""}).
                Contents: {formatCounts(preview.counts)}.
              </p>
              <ul className="backup-warnings">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <p className="settings-status warning">
                Restore is a full replace of the backed-up categories. Type{" "}
                <strong>RESTORE BACKUP</strong> to confirm.
              </p>
              <input
                type="text"
                value={restoreConfirm}
                aria-label="Type RESTORE BACKUP to confirm"
                placeholder="RESTORE BACKUP"
                onChange={(event) => setRestoreConfirm(event.target.value)}
              />
              <button
                type="button"
                className="primary"
                disabled={busy || restoreConfirm !== "RESTORE BACKUP"}
                onClick={() => void runApply()}
              >
                Restore backup
              </button>
            </div>
          )}
        </div>
      </section>
      <section className="data-delete">
        <h2>Delete local data</h2>
        <p className="settings-status">
          Each category is deleted separately and requires typing its exact
          confirmation phrase. Disconnecting Gmail and deleting its token is a
          separate action, except a full wipe. Individual documents can still be
          removed from the Documents tab.
        </p>
        <ul className="delete-list">
          {DELETION_CATEGORIES.map((item) => (
            <li
              key={item.category}
              className={item.category === "all" ? "danger" : undefined}
            >
              <div>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDeleteCategory(item.category);
                  setDeleteConfirm("");
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            </li>
          ))}
        </ul>
        {activeDelete && (
          <div
            className="delete-confirm"
            role="dialog"
            aria-label="Confirm deletion"
          >
            <p>
              Type <strong>{activeDelete.token}</strong> to delete{" "}
              {activeDelete.label.toLowerCase()}. This cannot be undone.
            </p>
            <input
              type="text"
              value={deleteConfirm}
              aria-label={`Type ${activeDelete.token} to confirm`}
              placeholder={activeDelete.token}
              onChange={(event) => setDeleteConfirm(event.target.value)}
            />
            <div className="delete-actions">
              <button
                type="button"
                className="danger"
                disabled={busy || deleteConfirm !== activeDelete.token}
                onClick={() => void runDelete()}
              >
                Delete permanently
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteCategory(null);
                  setDeleteConfirm("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
