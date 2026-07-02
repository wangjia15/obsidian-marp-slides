// Exports mutate shared process-wide state (process.env.CHROME_PATH, __dirname)
// and spawn a headless Chrome; running two at once corrupts both results.
let exportActive = false;

export function tryAcquireExportLock(): boolean {
    if (exportActive) {
        return false;
    }
    exportActive = true;
    return true;
}

export function releaseExportLock(): void {
    exportActive = false;
}
