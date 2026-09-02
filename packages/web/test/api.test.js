/**
 * Tests for the API client's error semantics.
 *
 * The UI branches on these flags — a queued offline write must not be
 * rendered as a failure, and a validation error must route to field
 * messages rather than a page-level alert — so they are worth pinning down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, API_BASE, isDesktop } from '../src/lib/api.js';

test('ApiError carries the server error contract', () => {
  const error = new ApiError('Validation failed', {
    status: 400,
    code: 'bad_request',
    details: { cost: 'Cost cannot be negative' },
    requestId: 'abc-123',
  });
  assert.equal(error.name, 'ApiError');
  assert.equal(error.status, 400);
  assert.equal(error.code, 'bad_request');
  assert.equal(error.requestId, 'abc-123');
  assert.deepEqual(error.details, { cost: 'Cost cannot be negative' });
  assert.ok(error instanceof Error);
});

test('isValidationError distinguishes field errors from other failures', () => {
  const validation = new ApiError('Validation failed', {
    status: 400, code: 'bad_request', details: { name: 'Required' },
  });
  assert.equal(validation.isValidationError, true);

  // A 400 with no details is not a field-level error.
  assert.equal(new ApiError('Bad JSON', { status: 400, code: 'bad_json' }).isValidationError, false);
  // Nor is a 409.
  assert.equal(
    new ApiError('Taken', { status: 409, code: 'conflict', details: {} }).isValidationError,
    false,
  );
});

test('network and queued-offline errors are distinguishable', () => {
  const offline = new ApiError('No connection', { status: 0, code: 'network_error' });
  assert.equal(offline.isNetworkError, true);
  assert.equal(offline.isQueuedOffline, false);

  // The desktop app accepted the write for later; the UI must report this
  // as success-with-a-caveat, not as an error.
  const queued = new ApiError('Saved locally.', { status: 0, code: 'queued_offline' });
  assert.equal(queued.isQueuedOffline, true);
  assert.equal(queued.isNetworkError, false);

  const serverError = new ApiError('Boom', { status: 500, code: 'internal_error' });
  assert.equal(serverError.isNetworkError, false);
  assert.equal(serverError.isQueuedOffline, false);
});

test('API_BASE is relative when no absolute URL is configured', () => {
  // A relative base keeps development same-origin behind the Vite proxy:
  // no CORS preflight, and the refresh cookie stays first-party.
  assert.equal(API_BASE, '/api');
});

test('isDesktop is false outside Electron', () => {
  assert.equal(isDesktop(), false);
});
