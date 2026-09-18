const MAX_ENTRIES = 256;

const urls = new Map<string, string>();

const inflight = new Map<string, Promise<string | null>>();

export function cachedAssetUrl(ref: string): string | undefined {
  const url = urls.get(ref);
  if (url === undefined) return undefined;

  urls.delete(ref);
  urls.set(ref, url);
  return url;
}

export function loadAssetUrl(
  ref: string,
  load: (ref: string) => Promise<string | null>,
): Promise<string | null> {
  const hit = cachedAssetUrl(ref);
  if (hit !== undefined) return Promise.resolve(hit);

  const existing = inflight.get(ref);
  if (existing) return existing;

  const request = load(ref)
    .catch(() => null)
    .then((url) => {
      if (url) remember(ref, url);
      inflight.delete(ref);
      return url;
    });
  inflight.set(ref, request);
  return request;
}

function remember(ref: string, url: string): void {
  urls.set(ref, url);
  while (urls.size > MAX_ENTRIES) {
    const oldest = urls.keys().next().value;
    if (oldest === undefined) break;
    const stale = urls.get(oldest);
    urls.delete(oldest);

    if (stale?.startsWith("blob:")) URL.revokeObjectURL(stale);
  }
}

export function clearAssetUrls(): void {
  for (const url of urls.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  urls.clear();
  inflight.clear();
}
