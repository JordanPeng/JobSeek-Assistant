export interface ResumeFactProposal {
  readonly path: string;
  readonly value: string;
  readonly evidence: string;
  readonly confidence: "high" | "medium";
  readonly confirmed: false;
}

export interface ResumeDraft {
  readonly proposals: readonly ResumeFactProposal[];
  readonly reviewNotes: readonly string[];
}

const HEADING =
  /^(resume|curriculum vitae|experience|employment|education|skills|summary|projects|contact|professional experience)$/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /(?<!\w)(?:\+?\d[\d\s().-]{7,}\d)(?!\w)/;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

function proposal(
  path: string,
  value: string,
  evidence: string,
  confidence: "high" | "medium",
): ResumeFactProposal {
  return { path, value, evidence, confidence, confirmed: false };
}

function likelyName(line: string): string | null {
  const trimmed = line.trim().replace(/\s+/g, " ");
  const words = trimmed.split(" ");
  if (
    trimmed.length < 3 ||
    trimmed.length > 60 ||
    words.length < 2 ||
    words.length > 4 ||
    HEADING.test(trimmed) ||
    /\d|@|https?:|[|,:;]/i.test(trimmed) ||
    !words.every((word) => /^[\p{L}][\p{L}'-]*$/u.test(word))
  ) {
    return null;
  }
  return trimmed;
}

/**
 * Extract only plainly written contact facts. Employment and education are
 * deliberately retained as review notes rather than inferred structured facts.
 */
export function createResumeDraft(text: string): ResumeDraft {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 500);
  const proposals: ResumeFactProposal[] = [];
  const seenPaths = new Set<string>();
  const add = (item: ResumeFactProposal): void => {
    if (!seenPaths.has(item.path)) {
      seenPaths.add(item.path);
      proposals.push(item);
    }
  };

  for (const line of lines) {
    const email = EMAIL.exec(line)?.[0];
    if (email) add(proposal("contact.email", email, line, "high"));
    const phone = PHONE.exec(line)?.[0]?.trim();
    if (phone) add(proposal("contact.phone", phone, line, "high"));
    for (const url of line.match(URL_PATTERN) ?? []) {
      const clean = url.replace(/[.,;]+$/, "");
      let hostname: string;
      try {
        hostname = new URL(clean).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (hostname.includes("linkedin.com")) {
        add(proposal("links.linkedin", clean, line, "high"));
      } else if (hostname.includes("github.com")) {
        add(proposal("links.github", clean, line, "high"));
      } else {
        add(proposal("links.portfolio", clean, line, "medium"));
      }
    }
  }

  for (const line of lines.slice(0, 8)) {
    const name = likelyName(line);
    if (name) {
      add(proposal("name.full", name, line, "medium"));
      break;
    }
  }

  const reviewNotes = lines
    .filter((line) =>
      /\b(education|experience|employment|university|college|engineer|developer|manager)\b/i.test(
        line,
      ),
    )
    .slice(0, 12)
    .map((line) => `Review only: ${line}`);
  return { proposals, reviewNotes };
}
