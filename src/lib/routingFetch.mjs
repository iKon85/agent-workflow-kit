/**
 * The HTTP layer for live routing evidence: one GET, one artifact, one attempt.
 *
 * Fail loud, never silent. Every non-200, unparseable, oversized or timed-out
 * response throws, because `refreshRoutingEvidence` already catches a failing
 * `load()`, quarantines that source with its reason, and keeps the previous
 * cache. Throwing *is* the quarantine trigger, so this module never returns a
 * degraded artifact and never retries: a retry loop would hide the outage the
 * quarantine exists to report, and a second error path would compete with the
 * one the command already owns.
 *
 * Attribution travels with the request. The sources publish under terms that
 * require retained attribution, so the `User-Agent` names the Kit rather than
 * an anonymous runtime default.
 */
import { createHash } from 'node:crypto';

/** One artifact, one attempt: the ceiling on a single GET. */
export const ROUTING_FETCH_TIMEOUT_MS = 20_000;

/** The largest artifact accepted; the recorded DeepSWE response is ~62 KB. */
export const ROUTING_FETCH_MAX_BYTES = 8 * 1024 * 1024;

export const ROUTING_FETCH_USER_AGENT = 'agent-workflow-kit routing evidence';

/** The named reasons a fetch can fail with; each one is a quarantine reason. */
export const ROUTING_FETCH_REASONS = Object.freeze([
  'request-failed',
  'http-status',
  'oversize',
  'not-json',
  'timeout',
]);

export class RoutingFetchError extends Error {
  constructor(reason, url, detail, status = null) {
    super(`routing fetch ${url} ${detail}`);
    this.name = 'RoutingFetchError';
    this.reason = reason;
    this.url = url;
    this.status = status;
  }
}

async function readCapped(response, url, maxBytes) {
  const decoder = new TextDecoder();
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes) {
      throw new RoutingFetchError('oversize', url, `exceeded the ${maxBytes}-byte cap`);
    }
    return { text, bytes };
  }
  let bytes = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      // Abort mid-body: an oversized artifact is refused, never truncated into
      // a payload that would parse as a smaller, wrong leaderboard.
      await reader.cancel();
      throw new RoutingFetchError('oversize', url, `exceeded the ${maxBytes}-byte cap`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), bytes };
}

function parsed(text, url) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RoutingFetchError('not-json', url, `did not return JSON: ${error.message}`);
  }
}

function named(error, url, timeoutMs) {
  if (error instanceof RoutingFetchError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new RoutingFetchError('timeout', url, `timed out after ${timeoutMs}ms`);
  }
  return new RoutingFetchError('request-failed', url, `request failed: ${error?.message ?? error}`);
}

/**
 * GET one artifact and return its parsed JSON with the hash of the exact bytes
 * received, so a caller can pin the snapshot it ingested.
 */
export async function fetchJsonArtifact({
  url,
  timeoutMs = ROUTING_FETCH_TIMEOUT_MS,
  maxBytes = ROUTING_FETCH_MAX_BYTES,
  userAgent = ROUTING_FETCH_USER_AGENT,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('url must be a non-empty string');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': userAgent },
    });
    if (response.status !== 200) {
      throw new RoutingFetchError(
        'http-status',
        url,
        `returned HTTP ${response.status}`,
        response.status,
      );
    }
    const { text, bytes } = await readCapped(response, url, maxBytes);
    return Object.freeze({
      url,
      bytes,
      payload: parsed(text, url),
      snapshotHash: `sha256-${createHash('sha256').update(text).digest('base64url')}`,
    });
  } catch (error) {
    throw named(error, url, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}
