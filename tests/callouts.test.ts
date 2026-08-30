import { describe, expect, test } from '@jest/globals';
import { transformCallouts, hasCallouts, buildCalloutCss } from '../src/utilities/callouts';
import { createMarpInstance } from '../src/utilities/marpInstance';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';

describe('hasCallouts', () => {
    test('detects a callout blockquote', () => {
        expect(hasCallouts('> [!note] Hi\n> body')).toBe(true);
    });
    test('plain blockquote is not a callout', () => {
        expect(hasCallouts('> just a quote')).toBe(false);
    });
    test('ignores callouts inside fenced code', () => {
        expect(hasCallouts('```md\n> [!note] example\n```')).toBe(false);
    });
    test('nested callout inside a parent callout is detected', () => {
        expect(hasCallouts('> [!note] Parent\n> > [!tip] Child\n> > body')).toBe(true);
    });
});

describe('transformCallouts', () => {
    test('no-op when there is no callout', () => {
        const md = '# Title\n\n> normal quote\n';
        expect(transformCallouts(md)).toBe(md);
    });

    test('rewrites a simple callout into a styled div with default title', () => {
        const out = transformCallouts('> [!warning]\n> Be careful.');
        expect(out).toContain('<div class="callout callout-warning">');
        expect(out).toContain('<div class="callout-title">Warning</div>');
        expect(out).toContain('Be careful.');
        expect(out).toContain('</div>');
    });

    test('honours a custom title', () => {
        const out = transformCallouts('> [!info] Custom Heading\n> text');
        expect(out).toContain('<div class="callout-title">Custom Heading</div>');
    });

    test('maps aliases to the canonical type', () => {
        expect(transformCallouts('> [!tldr] x\n> y')).toContain('class="callout callout-abstract"');
        expect(transformCallouts('> [!caution] x\n> y')).toContain('class="callout callout-warning"');
    });

    test('unknown type falls back to note styling but keeps its label', () => {
        const out = transformCallouts('> [!custom]\n> body');
        expect(out).toContain('class="callout callout-note"');
        expect(out).toContain('<div class="callout-title">Custom</div>');
    });

    test('drops the fold marker', () => {
        const out = transformCallouts('> [!note]- Collapsed\n> hidden body');
        expect(out).toContain('<div class="callout-title">Collapsed</div>');
        expect(out).toContain('hidden body');
    });

    test('keeps body markdown intact for later parsing', () => {
        const out = transformCallouts('> [!tip] T\n> - one\n> - two\n>\n> **bold**');
        expect(out).toContain('- one');
        expect(out).toContain('- two');
        expect(out).toContain('**bold**');
        // blank line between the opening divs and the body (markdown-in-html trick)
        expect(out).toMatch(/<div class="callout-body">\n\n- one/);
    });

    test('leaves callouts inside fenced code untouched', () => {
        const md = 'text\n\n```\n> [!note] not a callout\n```\n';
        expect(transformCallouts(md)).toBe(md);
    });

    test('escapes HTML in the title', () => {
        const out = transformCallouts('> [!note] <script>alert(1)</script>\n> b');
        expect(out).toContain('&lt;script&gt;');
        expect(out).not.toContain('<script>');
    });

    test('handles a callout with no body', () => {
        const out = transformCallouts('> [!note] Just a title');
        expect(out).toContain('<div class="callout callout-note">');
        expect(out).toContain('<div class="callout-title">Just a title</div>');
        expect(out).not.toContain('callout-body');
    });
});

describe('buildCalloutCss', () => {
    test('emits a rule + icon for every built-in type, scoped to section', () => {
        const css = buildCalloutCss();
        expect(css).toContain('section .callout{');
        expect(css).toContain('section .callout-warning::before{content:"⚠"');
        expect(css).toContain('section .callout-danger{border-left-color:#ff1744');
    });
});

describe('end-to-end Marp render', () => {
    // Force the narrow-allowlist path (no full HTML passthrough): kroki mermaid
    // + HTML disabled is exactly when the callout allowlist has to carry it.
    const allowlistSettings = { ...DEFAULT_SETTINGS, MermaidRenderMode: 'kroki' as const, EnableHTML: false };

    test('callout HTML survives the render (not escaped) via the narrow allowlist', () => {
        const marp = createMarpInstance(allowlistSettings);
        const md = transformCallouts('# Deck\n\n> [!warning] Heads up\n> Body **text**.');
        const { html } = marp.render(md);

        expect(html).toContain('<div class="callout callout-warning">');
        expect(html).toContain('class="callout-title"');
        // body markdown got rendered to real elements inside the callout
        expect(html).toContain('<strong>text</strong>');
        expect(html).not.toContain('&lt;div class="callout');
    });

    test('the allowlist drops event handlers and unknown tags/attributes', () => {
        const marp = createMarpInstance(allowlistSettings);
        const { html } = marp.render('<div class="ok" onclick="evil()">x</div>\n\n<iframe src="x"></iframe>');
        expect(html).toContain('class="ok"');
        expect(html).not.toContain('onclick');
        expect(html).not.toContain('<iframe');
    });

    test('full HTML passthrough (default local-mermaid settings) also renders callouts', () => {
        const marp = createMarpInstance(DEFAULT_SETTINGS);
        const { html } = marp.render(transformCallouts('> [!tip] T\n> body'));
        expect(html).toContain('<div class="callout callout-tip">');
    });
});
