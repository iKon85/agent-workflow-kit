import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanServices } from '../scripts/census-local/scan-services.mjs';
test('local scanner recognizes payments', () => assert.deepEqual(scanServices(), ['services/payments/src']));
