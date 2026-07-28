import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  ROUTING_FETCH_USER_AGENT,
  RoutingFetchError,
  fetchJsonArtifact,
} from '../src/lib/routingFetch.mjs';

// Every case runs against a loopback server started for the case: the suite
// must stay green with networking unavailable, so no test may reach an owner.
async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/artifact.json`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the fetch to reject');
}

test('a 200 JSON response yields the parsed payload, its size and a snapshot hash', async () => {
  const seen = {};
  await withServer((request, response) => {
    seen.userAgent = request.headers['user-agent'];
    seen.method = request.method;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ rows: [{ model: 'claude-opus-5' }] }));
  }, async (url) => {
    const result = await fetchJsonArtifact({ url });
    assert.deepEqual(result.payload, { rows: [{ model: 'claude-opus-5' }] });
    assert.equal(result.url, url);
    assert.ok(result.bytes > 0);
    assert.match(result.snapshotHash, /^sha256-[A-Za-z0-9_-]+$/);
  });
  assert.equal(seen.method, 'GET');
  assert.equal(seen.userAgent, ROUTING_FETCH_USER_AGENT);
  assert.match(seen.userAgent, /agent-workflow-kit/);
});

test('a non-200 response throws a named reason and never returns a body', async () => {
  await withServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end('{"rows":[]}');
  }, async (url) => {
    const error = await rejection(fetchJsonArtifact({ url }));
    assert.ok(error instanceof RoutingFetchError);
    assert.equal(error.reason, 'http-status');
    assert.equal(error.status, 503);
    assert.match(error.message, /503/);
    assert.match(error.message, new RegExp(url.replace(/[/.]/g, '\\$&')));
  });
});

test('a non-JSON response throws a named reason', async () => {
  await withServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>leaderboard</title>');
  }, async (url) => {
    const error = await rejection(fetchJsonArtifact({ url }));
    assert.ok(error instanceof RoutingFetchError);
    assert.equal(error.reason, 'not-json');
  });
});

test('a response past the size cap is aborted with a named reason', async () => {
  await withServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ filler: 'x'.repeat(4096) }));
  }, async (url) => {
    const error = await rejection(fetchJsonArtifact({ url, maxBytes: 256 }));
    assert.ok(error instanceof RoutingFetchError);
    assert.equal(error.reason, 'oversize');
    assert.match(error.message, /256/);
  });
});

test('a response that never arrives is aborted with a named timeout reason', async () => {
  await withServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    // Deliberately never ends: the abort must come from the caller's timeout.
  }, async (url) => {
    const error = await rejection(fetchJsonArtifact({ url, timeoutMs: 60 }));
    assert.ok(error instanceof RoutingFetchError);
    assert.equal(error.reason, 'timeout');
    assert.match(error.message, /60/);
  });
});

test('a transport failure is reported as a named reason, not swallowed', async () => {
  const error = await rejection(fetchJsonArtifact({
    url: 'https://example.invalid/artifact.json',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  }));
  assert.ok(error instanceof RoutingFetchError);
  assert.equal(error.reason, 'request-failed');
  assert.match(error.message, /fetch failed/);
});

test('exactly one attempt is made — there is no retry loop', async () => {
  let attempts = 0;
  await rejection(fetchJsonArtifact({
    url: 'https://example.invalid/artifact.json',
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('fetch failed');
    },
  }));
  assert.equal(attempts, 1);
});

test('an empty url is rejected before any request is attempted', async () => {
  let attempts = 0;
  await assert.rejects(
    () => fetchJsonArtifact({ url: '', fetchImpl: async () => { attempts += 1; } }),
    /url must be a non-empty string/,
  );
  assert.equal(attempts, 0);
});
