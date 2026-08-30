import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';

// exportLock holds module-level state, so each test needs a fresh module
// instance — jest.resetModules() + re-require gives every test its own
// exportActive/acquiredAt pair instead of leaking across tests.
describe('exportLock', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('a second acquire fails while the lock is held', () => {
        const { tryAcquireExportLock } = require('../src/utilities/exportLock');
        expect(tryAcquireExportLock()).toBe(true);
        expect(tryAcquireExportLock()).toBe(false);
    });

    test('release lets a later acquire succeed', () => {
        const { tryAcquireExportLock, releaseExportLock } = require('../src/utilities/exportLock');
        expect(tryAcquireExportLock()).toBe(true);
        releaseExportLock();
        expect(tryAcquireExportLock()).toBe(true);
    });

    test('a lock held past the staleness window is reclaimed without an explicit release', () => {
        jest.useFakeTimers();
        const { tryAcquireExportLock } = require('../src/utilities/exportLock');

        expect(tryAcquireExportLock()).toBe(true);
        // Simulate a hung export (e.g. browser.close() never resolving): the lock
        // is never released, but 5+ minutes pass.
        jest.advanceTimersByTime(5 * 60 * 1000 + 1);

        expect(tryAcquireExportLock()).toBe(true);
    });

    test('a lock held under the staleness window is not reclaimed', () => {
        jest.useFakeTimers();
        const { tryAcquireExportLock } = require('../src/utilities/exportLock');

        expect(tryAcquireExportLock()).toBe(true);
        jest.advanceTimersByTime(60 * 1000);

        expect(tryAcquireExportLock()).toBe(false);
    });
});
