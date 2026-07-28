/**
 * The dispatch lease — the revision-bound window between deciding a route and
 * spawning the agent that runs it.
 *
 * Comparing revisions before and after the handoff is not enough on its own: a
 * comparison leaves a window between the check and the external task creation in
 * which an authorization can be revoked, and the dispatch would still spawn. The
 * lease closes that window from both sides. A dispatch holds it across the whole
 * handoff, bound to the store-backed snapshot token it read; a writer must
 * invalidate the lease or wait for it, and a lease whose revisions no longer
 * match fails the dispatch instead of racing it.
 *
 * Four mechanics carry that:
 *
 * - **Fencing token.** Every acquisition raises a monotone counter per scope. A
 *   holder proves itself by its token, so a holder that lost the lease can
 *   neither continue nor release its successor's.
 * - **Expiry.** A lease is only live until its deadline. A crashed holder
 *   therefore cannot block a scope forever.
 * - **Abandoned-lease recovery.** An expired lease is taken over by the next
 *   acquirer or by a waiting writer, and the fence bump makes the abandoned
 *   holder's next check fail rather than letting it spawn late.
 * - **Writer fairness.** A writer queues for its turn, and while any writer is
 *   queued no new dispatch may acquire the scope. Writers are served in the
 *   order they queued, so a stream of dispatches can never starve a revocation.
 *
 * The registry is per-process mutual exclusion. What catches a mutation from
 * *another* process is the revision binding: the lease re-reads the persisted
 * profile generations, inventory, Access graph and catalog and recomputes the
 * Routing policy, then compares. Both halves are needed — a cooperating writer
 * is serialized, an uncoordinated one is detected.
 */
import { readAccessGraphDocument } from './routingAccessGraphStore.mjs';
import { readComposedRoutingProfile } from './routingProfile.mjs';
import {
  assertRoutingSnapshotMatches,
  assertRoutingStoreSnapshotUnchanged,
  captureRoutingStoreSnapshot,
} from './routingEvidenceCache.mjs';

export const DISPATCH_LEASE_VERSION = 1;
export const DEFAULT_DISPATCH_LEASE_TTL_MS = 30_000;
export const DEFAULT_WRITER_TURN_TIMEOUT_MS = 5_000;

/** The Route decision axes a lease binds: exactly what the decision named. */
const DECISION_REVISION_FIELDS = Object.freeze(['catalog', 'accessGraph', 'policy']);

const sleepMs = (ms) => new Promise((done) => { setTimeout(done, ms); });

function scopeKey(value, field = 'dispatch lease key') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * One registry owns the leases of one process. `now` and `ttlMs` are injected so
 * expiry, recovery and fairness are decidable without waiting for wall time.
 */
export function createDispatchLeaseRegistry({
  now = () => Date.now(),
  ttlMs = DEFAULT_DISPATCH_LEASE_TTL_MS,
} = {}) {
  const scopes = new Map();

  const scopeOf = (key) => {
    const name = scopeKey(key);
    if (!scopes.has(name)) {
      scopes.set(name, { fencingToken: 0, lease: null, writers: [], tickets: 0 });
    }
    return scopes.get(name);
  };
  /** A lease is live only while it exists and its deadline has not passed. */
  const live = (scope, at) => (scope.lease && at < scope.lease.expiresAt ? scope.lease : null);

  function acquire({ key, holder = null, ttlMs: leaseTtlMs = ttlMs } = {}) {
    const scope = scopeOf(key);
    if (scope.writers.length > 0) {
      throw new Error(`dispatch lease is reserved for a writer: ${key}`);
    }
    const at = now();
    if (live(scope, at)) throw new Error(`dispatch lease is held: ${key}`);
    // An expired lease is abandoned: the recovering acquirer fences its holder.
    scope.fencingToken += 1;
    scope.lease = {
      schemaVersion: DISPATCH_LEASE_VERSION,
      key,
      holder,
      fencingToken: scope.fencingToken,
      acquiredAt: at,
      expiresAt: at + leaseTtlMs,
    };
    return Object.freeze({ ...scope.lease });
  }

  /** Still ours, still live — or the dispatch fails with what went wrong. */
  function assertHeld(lease) {
    const current = scopes.get(lease?.key)?.lease ?? null;
    if (!current || current.fencingToken !== lease?.fencingToken) {
      throw new Error(`dispatch lease superseded: ${lease?.key}`);
    }
    if (now() >= current.expiresAt) throw new Error(`dispatch lease expired: ${lease.key}`);
    return true;
  }

  /** Only the current holder releases; a fenced holder cannot free its successor. */
  function release(lease) {
    const scope = scopes.get(lease?.key);
    if (scope?.lease && scope.lease.fencingToken === lease.fencingToken) scope.lease = null;
    return true;
  }

  /** Queue for a write. From here on, no new dispatch may take this scope. */
  function requestWriterTurn({ key, writerId = null } = {}) {
    const scope = scopeOf(key);
    scope.tickets += 1;
    const ticket = Object.freeze({ key, writerId, sequence: scope.tickets });
    scope.writers.push(ticket);
    return ticket;
  }

  /**
   * Take the turn if it is this writer's and no live lease is in the way. The
   * grant invalidates whatever remains of an abandoned lease and raises the
   * fence, so a stale holder can no longer spawn against the old revisions.
   */
  function tryBeginWrite(ticket) {
    const scope = scopeOf(ticket?.key);
    const head = scope.writers[0];
    if (!head || head.sequence !== ticket.sequence) {
      return Object.freeze({ granted: false, reason: 'writer-not-next' });
    }
    if (live(scope, now())) {
      return Object.freeze({ granted: false, reason: 'dispatch-lease-held' });
    }
    scope.lease = null;
    scope.fencingToken += 1;
    return Object.freeze({ granted: true, fencingToken: scope.fencingToken });
  }

  /** Leave the queue, whether the turn was taken or given up. */
  function endWrite(ticket) {
    const scope = scopeOf(ticket?.key);
    scope.writers = scope.writers.filter((queued) => queued.sequence !== ticket.sequence);
    return true;
  }

  function inspect(key) {
    const scope = scopeOf(key);
    const current = live(scope, now());
    return Object.freeze({
      fencingToken: scope.fencingToken,
      held: Boolean(current),
      holder: current?.holder ?? null,
      expiresAt: scope.lease?.expiresAt ?? null,
      writers: scope.writers.length,
    });
  }

  return Object.freeze({
    acquire, assertHeld, release, requestWriterTurn, tryBeginWrite, endWrite, inspect,
  });
}

/**
 * Wait for a queued writer's turn. The wait is bounded by wall time, so a holder
 * whose process died mid-dispatch cannot keep a revocation waiting forever; the
 * timeout names the reason it was still blocked.
 */
export async function awaitWriteTurn(registry, ticket, options = {}) {
  const {
    timeoutMs = DEFAULT_WRITER_TURN_TIMEOUT_MS,
    pollMs = 5,
    sleep = sleepMs,
    clock = Date.now,
  } = options;
  const deadline = clock() + timeoutMs;
  for (;;) {
    const attempt = registry.tryBeginWrite(ticket);
    if (attempt.granted) return attempt;
    if (clock() >= deadline) {
      throw new Error(`dispatch lease writer timed out: ${ticket?.key} (${attempt.reason})`);
    }
    await sleep(pollMs);
  }
}

/**
 * The snapshot source over the real user-local stores: the committed profile
 * generations plus the pinned inventory (composed and then derived into a
 * policy), the stored Access graph, and the Evidence catalog its own reader
 * supplies. Every `read` goes back to the bytes — nothing is cached across the
 * handoff, because a cached read cannot see a concurrent writer.
 */
export function createPersistedRoutingSnapshot({
  profileRoot, projectRoot, identity, runGit, loadInventory, inventory,
  accessGraphFile, readCatalog, policyOptions,
} = {}) {
  scopeKey(accessGraphFile, 'persisted routing snapshot accessGraphFile');
  return Object.freeze({
    read: () => captureRoutingStoreSnapshot({
      readProfile: () => readComposedRoutingProfile({
        profileRoot, projectRoot, identity, runGit, loadInventory, inventory,
      }),
      readAccessGraph: () => readAccessGraphDocument(accessGraphFile),
      readCatalog,
      policyOptions,
    }),
  });
}

/**
 * Open the lease for one dispatch: take the scope first, then read the store and
 * bind the lease to what the Route decision named. A store that already moved
 * fails here, before an adapter prepares anything, and the scope is released
 * again — an unopened lease never leaks.
 */
export async function openDispatchLease({
  registry, key, holder = null, ttlMs, snapshot, expected = null,
}) {
  if (!registry || typeof registry.acquire !== 'function') {
    throw new TypeError('a dispatch lease needs a dispatch lease registry');
  }
  if (!snapshot || typeof snapshot.read !== 'function') {
    throw new TypeError('a dispatch lease needs a store-backed snapshot source');
  }
  const lease = registry.acquire({ key, holder, ttlMs });
  try {
    const token = await snapshot.read();
    if (expected) assertRoutingSnapshotMatches(expected, token, DECISION_REVISION_FIELDS);
    registry.assertHeld(lease);
    return Object.freeze({
      key: lease.key,
      holder: lease.holder,
      fencingToken: lease.fencingToken,
      expiresAt: lease.expiresAt,
      token,
      /** The spawn handoff: re-read, compare, and prove the lease is still ours. */
      revalidate: async () => {
        registry.assertHeld(lease);
        const current = await snapshot.read();
        assertRoutingStoreSnapshotUnchanged(token, current);
        registry.assertHeld(lease);
        return current;
      },
      release: () => registry.release(lease),
    });
  } catch (error) {
    registry.release(lease);
    throw error;
  }
}
