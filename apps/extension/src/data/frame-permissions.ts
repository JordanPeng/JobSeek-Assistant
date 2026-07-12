const ATS_FRAME_HOSTS = [
  /(^|\.)greenhouse\.io$/i,
  /^jobs\.lever\.co$/i,
  /^jobs\.ashbyhq\.com$/i,
  /(^|\.)myworkdayjobs\.com$/i,
  /^jobs\.smartrecruiters\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)taleo\.net$/i,
] as const;

export function applicationFramePermissionPattern(
  value: string,
): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !ATS_FRAME_HOSTS.some((pattern) => pattern.test(url.hostname))
    ) {
      return null;
    }
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

export function applicationFramePermissionPatterns(
  urls: readonly string[],
): readonly string[] {
  return [
    ...new Set(
      urls
        .map(applicationFramePermissionPattern)
        .filter((pattern): pattern is string => pattern !== null),
    ),
  ];
}

export async function ensureApplicationFramePermissions(): Promise<{
  readonly origins: readonly string[];
  readonly granted: boolean;
}> {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });
  const tabId = tabs.at(0)?.id;
  if (tabId === undefined) {
    return { origins: [], granted: true };
  }
  const results = await browser.scripting.executeScript({
    target: { tabId },
    func: () =>
      Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[src]"))
        .map((frame) => frame.src)
        .filter(Boolean),
  });
  const frameUrls = results.at(0)?.result;
  const origins = applicationFramePermissionPatterns(
    Array.isArray(frameUrls) ? frameUrls : [],
  );
  const missing: string[] = [];
  for (const origin of origins) {
    if (!(await browser.permissions.contains({ origins: [origin] }))) {
      missing.push(origin);
    }
  }
  if (missing.length === 0) {
    return { origins, granted: true };
  }
  return {
    origins,
    granted: await browser.permissions.request({ origins: missing }),
  };
}
