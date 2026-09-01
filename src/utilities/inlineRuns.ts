// One stretch of inline text sharing a single computed style, collected from a
// rendered text element's DOM text nodes. Runs are what lets mixed inline
// formatting survive into the pptx instead of being flattened to the
// paragraph's single box-level style: a bold word inside a sentence, a link, a
// `<mark>` highlight, inline `<code>` colors, and — the original use case —
// the per-token highlight.js colors of a fenced code block.
//
// This module is deliberately dependency-free (no obsidian / puppeteer
// imports) so the merge logic can be unit tested in isolation
// (see tests/inlineRuns.test.ts); the DOM-side collector itself has to live
// inside the page.evaluate callback in editablePptxExport.ts.
export interface InlineRun {
    text: string;
    color: string;
    // The run's own non-transparent background (an inline <code> fill, a
    // <mark> highlight) — becomes a pptxgenjs run `highlight`.
    backgroundColor?: string;
    fontWeight: string;
    fontStyle: string;
    // px, per run: sub/sup/small-sized spans keep their own size.
    fontSize: number;
    underline?: boolean;
    href?: string;
}

function sameStyle(a: InlineRun, b: InlineRun): boolean {
    return (
        a.color === b.color &&
        a.backgroundColor === b.backgroundColor &&
        a.fontWeight === b.fontWeight &&
        a.fontStyle === b.fontStyle &&
        a.fontSize === b.fontSize &&
        a.underline === b.underline &&
        a.href === b.href
    );
}

// Collapses adjacent runs that share one style into single runs. The DOM-side
// collector emits one run per text node (one per highlight.js token, one per
// styled word), which would bloat the generated XML and can trip PowerPoint's
// per-paragraph run limits on dense code blocks; merged runs render identically.
export function mergeInlineRuns(runs: InlineRun[]): InlineRun[] {
    const merged: InlineRun[] = [];
    for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last && sameStyle(last, run)) {
            last.text += run.text;
        } else {
            merged.push({ ...run });
        }
    }
    return merged;
}
