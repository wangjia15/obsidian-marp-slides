// Exports mutate shared process-wide state (process.env.CHROME_PATH, __dirname)
// and spawn a headless Chrome; running two at once corrupts both results.
let exportActive = false;
let acquiredAt = 0;

// A hung Chrome shutdown (browser.close() waiting forever on a zombie process —
// an observed flake, especially on Windows) would otherwise leave the lock held
// until Obsidian is restarted, silently blocking every export from then on,
// including unrelated ones (this lock is shared by the marp-cli PDF/PPTX/PNG/HTML
// path and the editable PPTX path). Treat a lock older than this as abandoned so
// a later export attempt can self-heal instead of requiring a restart.
const STALE_LOCK_MS = 5 * 60 * 1000;

export function tryAcquireExportLock(): boolean {
    if (exportActive) {
        if (Date.now() - acquiredAt < STALE_LOCK_MS) {
            return false;
        }
        console.warn('Marp Slides: the previous export still held its lock after 5 minutes and appears to be stuck; reclaiming it.');
    }
    exportActive = true;
    acquiredAt = Date.now();
    return true;
}

export function releaseExportLock(): void {
    exportActive = false;
}
