// Obsidian callout support for Marp decks.
//
// Obsidian writes callouts (a.k.a. admonitions) as a blockquote whose first
// line is `[!type]`:
//
//   > [!warning] Optional custom title
//   > Body text, **markdown** works here.
//   > - and lists too
//
// Marp / Marpit only see a plain `<blockquote>`, losing the type, the icon and
// the colour. This module rewrites every callout blockquote into a small block
// of raw HTML (`<div class="callout callout-warning">…`) that `buildCalloutCss`
// then styles. The body is emitted with blank lines around it so markdown-it
// still parses the inner markdown normally (the well-known "markdown in HTML
// block" trick), which keeps bold/lists/links/images working inside a callout.
//
// The raw HTML only needs `div`/`p`/`span` with a `class` attribute, so the
// render paths enable it through a narrow allowlist rather than full HTML
// passthrough (see createMarpInstance / the marp-cli engine config).

interface CalloutStyle {
    /** Accent colour (border + icon + title). */
    color: string;
    /** Icon glyph rendered via `::before`; kept to BMP symbols with wide font coverage. */
    icon: string;
    /** Default title when the author gives none. */
    label: string;
}

// Canonical callout types Obsidian ships, with their accent colour and icon.
const CALLOUTS: Record<string, CalloutStyle> = {
    note: { color: '#448aff', icon: '✎', label: 'Note' },
    abstract: { color: '#00b0ff', icon: '≡', label: 'Abstract' },
    info: { color: '#00b8d4', icon: 'ℹ', label: 'Info' },
    todo: { color: '#00b8d4', icon: '☑', label: 'Todo' },
    tip: { color: '#00bfa6', icon: '★', label: 'Tip' },
    success: { color: '#00c853', icon: '✓', label: 'Success' },
    question: { color: '#e6a700', icon: '?', label: 'Question' },
    warning: { color: '#ff9100', icon: '⚠', label: 'Warning' },
    failure: { color: '#ff5252', icon: '✗', label: 'Failure' },
    danger: { color: '#ff1744', icon: '‼', label: 'Danger' },
    bug: { color: '#f50057', icon: '⚠', label: 'Bug' },
    example: { color: '#7c4dff', icon: '❖', label: 'Example' },
    quote: { color: '#9e9e9e', icon: '❝', label: 'Quote' },
};

// Obsidian's aliases -> canonical type.
const ALIASES: Record<string, string> = {
    summary: 'abstract',
    tldr: 'abstract',
    hint: 'tip',
    important: 'tip',
    check: 'success',
    done: 'success',
    help: 'question',
    faq: 'question',
    caution: 'warning',
    attention: 'warning',
    fail: 'failure',
    missing: 'failure',
    error: 'danger',
    cite: 'quote',
};

// First line of a callout blockquote: `> [!type]` with optional fold marker and title.
const CALLOUT_HEAD = /^([ \t]*)>[ \t]?\[!([\w-]+)\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const BLOCKQUOTE_LINE = /^[ \t]*>/;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function titleCase(type: string): string {
    return type.charAt(0).toUpperCase() + type.slice(1);
}

/** True when the markdown contains at least one Obsidian callout (fenced code ignored). */
export function hasCallouts(markdown: string): boolean {
    let fence: string | null = null;
    for (const line of markdown.split('\n')) {
        const fenceMatch = FENCE.exec(line);
        if (fence) {
            if (fenceMatch && line.trim().startsWith(fence)) fence = null;
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1][0].repeat(3);
            continue;
        }
        if (CALLOUT_HEAD.test(line)) return true;
    }
    return false;
}

function renderCallout(block: string[]): string[] {
    const head = CALLOUT_HEAD.exec(block[0]);
    if (!head) return block;

    const [, , rawType, , inlineTitle] = head;
    const type = rawType.toLowerCase();
    const canonical = CALLOUTS[type] ? type : ALIASES[type];
    // Unknown types render with `note` styling but keep their own name as the title.
    const known = canonical ?? 'note';
    const title =
        (inlineTitle && inlineTitle.trim()) ||
        (canonical ? CALLOUTS[canonical].label : titleCase(type));

    // Strip one `>` quote level from every line of the block.
    const inner = block.map((l) => l.replace(/^[ \t]*>[ \t]?/, ''));
    const bodyLines = inner.slice(1);
    while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop();

    const out: string[] = [
        '',
        `<div class="callout callout-${known}">`,
        `<div class="callout-title">${escapeHtml(title)}</div>`,
    ];

    if (bodyLines.length > 0) {
        // Recurse so a nested `> > [!info]` callout is handled too.
        const body = transformCallouts(bodyLines.join('\n'));
        out.push('<div class="callout-body">', '', ...body.split('\n'), '', '</div>');
    }

    out.push('</div>', '');
    return out;
}

/**
 * Rewrite every Obsidian callout blockquote in the deck into styled raw HTML.
 * Content inside fenced code blocks is left untouched. Returns the input
 * unchanged when there is no callout to convert.
 */
export function transformCallouts(markdown: string): string {
    const lines = markdown.split('\n');
    const out: string[] = [];
    let fence: string | null = null;
    let changed = false;
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const fenceMatch = FENCE.exec(line);

        if (fence) {
            out.push(line);
            if (fenceMatch && line.trim().startsWith(fence)) fence = null;
            i++;
            continue;
        }
        if (fenceMatch) {
            fence = fenceMatch[1][0].repeat(3);
            out.push(line);
            i++;
            continue;
        }

        if (!CALLOUT_HEAD.test(line)) {
            out.push(line);
            i++;
            continue;
        }

        // Gather the contiguous blockquote that starts on this line.
        let j = i;
        const block: string[] = [];
        while (j < lines.length && BLOCKQUOTE_LINE.test(lines[j])) {
            block.push(lines[j]);
            j++;
        }

        out.push(...renderCallout(block));
        changed = true;
        i = j;
    }

    return changed ? out.join('\n') : markdown;
}

/**
 * CSS styling every `.callout` block, scoped to `section` so it applies in the
 * in-app preview and in every marp-cli / editable-PPTX export. Appended after
 * the theme CSS, so source order alone makes it win.
 */
export function buildCalloutCss(): string {
    const rules: string[] = [
        'section .callout{position:relative;margin:.7em 0;padding:.55em .95em .55em 2.5em;' +
            'border-radius:6px;border-left:4px solid #8a8a8a;background:#8a8a8a1f;' +
            'font-size:.9em;line-height:1.45;overflow:hidden}',
        'section .callout::before{position:absolute;left:.75em;top:.5em;font-weight:700;' +
            'font-size:1.05em;line-height:1.4;color:#8a8a8a}',
        'section .callout>.callout-title{font-weight:700;margin:0 0 .15em;color:#8a8a8a}',
        'section .callout>.callout-body>:first-child{margin-top:0}',
        'section .callout>.callout-body>:last-child{margin-bottom:0}',
        'section .callout .callout{margin:.5em 0}',
    ];

    for (const [type, style] of Object.entries(CALLOUTS)) {
        rules.push(
            `section .callout-${type}{border-left-color:${style.color};background:${style.color}1f}`,
            `section .callout-${type}::before{content:"${style.icon}";color:${style.color}}`,
            `section .callout-${type}>.callout-title{color:${style.color}}`
        );
    }

    return `/* marp-slides callouts */\n${rules.join('\n')}\n`;
}

// The narrow HTML allowlist the render paths enable so callout markup survives
// without turning on full HTML passthrough for the whole deck.
export const CALLOUT_HTML_ALLOWLIST: Record<string, string[]> = {
    div: ['class'],
    p: ['class'],
    span: ['class'],
};
