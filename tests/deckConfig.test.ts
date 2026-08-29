import { describe, expect, test } from '@jest/globals';
import {
    resolveDeckConfig,
    parseFrontmatterOverrides,
    injectSizeDirective,
    ensureSizeMeta,
    injectMermaidInitTheme
} from '../src/utilities/deckConfig';
import { buildCodeThemeCss } from '../src/utilities/codeThemes';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';

describe('parseFrontmatterOverrides', () => {
    test('returns nothing without frontmatter', () => {
        expect(parseFrontmatterOverrides('# plain deck\n')).toEqual({});
    });

    test('reads native size and the marp-slides block', () => {
        const markdown = [
            '---',
            'size: 4:3',
            'marp-slides:',
            '  ratio: 16:9',
            '  code-theme: "one-dark"',
            "  mermaid-theme: 'dark'",
            '---',
            '',
            '# hi'
        ].join('\n');

        expect(parseFrontmatterOverrides(markdown)).toEqual({
            size: '4:3',
            ratio: '16:9',
            codeTheme: 'one-dark',
            mermaidTheme: 'dark'
        });
    });

    test('leaves the block when a new top-level key follows it', () => {
        const markdown = [
            '---',
            'marp-slides:',
            '  code-theme: monokai',
            'title: My Deck',
            '---'
        ].join('\n');

        const overrides = parseFrontmatterOverrides(markdown);
        expect(overrides.codeTheme).toBe('monokai');
        expect(overrides.size).toBeUndefined();
    });
});

describe('resolveDeckConfig', () => {
    test('falls back to settings defaults', () => {
        expect(resolveDeckConfig('# no frontmatter\n', DEFAULT_SETTINGS)).toEqual({
            ratio: '16:9',
            codeTheme: 'auto',
            mermaidTheme: 'default',
            sizeExplicit: false
        });
    });

    test('frontmatter marp-slides block overrides settings', () => {
        const markdown = '---\nmarp-slides:\n  ratio: 4:3\n  code-theme: dracula\n  mermaid-theme: forest\n---\n';
        expect(resolveDeckConfig(markdown, DEFAULT_SETTINGS)).toEqual({
            ratio: '4:3',
            codeTheme: 'dracula',
            mermaidTheme: 'forest',
            sizeExplicit: false
        });
    });

    test('native size directive wins for the ratio and marks it explicit', () => {
        const markdown = '---\nsize: 4:3\nmarp-slides:\n  ratio: 16:9\n---\n';
        const config = resolveDeckConfig(markdown, DEFAULT_SETTINGS);
        expect(config.ratio).toBe('4:3');
        expect(config.sizeExplicit).toBe(true);
    });

    test('unknown values are ignored rather than trusted', () => {
        const markdown = '---\nmarp-slides:\n  ratio: 21:9\n  code-theme: nope\n---\n';
        const config = resolveDeckConfig(markdown, DEFAULT_SETTINGS);
        expect(config.ratio).toBe('16:9');
        expect(config.codeTheme).toBe('auto');
    });
});

describe('injectSizeDirective', () => {
    test('creates frontmatter when the deck has none', () => {
        const out = injectSizeDirective('# hi\n', { ...resolveDeckConfig('', DEFAULT_SETTINGS), ratio: '4:3' });
        expect(out.startsWith('---\nsize: 4:3\n---\n\n# hi')).toBe(true);
    });

    test('adds size to existing frontmatter without touching other keys', () => {
        const markdown = '---\ntheme: blackboard\n---\n\n# hi\n';
        const out = injectSizeDirective(markdown, { ...resolveDeckConfig(markdown, DEFAULT_SETTINGS), ratio: '4:3' });
        expect(out).toBe('---\nsize: 4:3\ntheme: blackboard\n---\n\n# hi\n');
    });

    test('preserves CRLF line endings', () => {
        const markdown = '---\r\ntheme: blackboard\r\n---\r\n\r\n# hi\r\n';
        const config = resolveDeckConfig(markdown, DEFAULT_SETTINGS);
        const out = injectSizeDirective(markdown, { ...config, ratio: '4:3' });
        expect(out).toBe('---\r\nsize: 4:3\r\ntheme: blackboard\r\n---\r\n\r\n# hi\r\n');
        expect(resolveDeckConfig(out, DEFAULT_SETTINGS).sizeExplicit).toBe(true);
    });

    test('never touches a deck that pins its own size', () => {
        const markdown = '---\nsize: 4:3\n---\n\n# hi\n';
        const config = resolveDeckConfig(markdown, DEFAULT_SETTINGS);
        expect(injectSizeDirective(markdown, config)).toBe(markdown);
    });

    test('never touches a deck using an inline size comment', () => {
        const markdown = '# hi\n\n<!-- size: 16:9 -->\n';
        const config = resolveDeckConfig(markdown, DEFAULT_SETTINGS);
        expect(injectSizeDirective(markdown, config)).toBe(markdown);
    });
});

describe('ensureSizeMeta', () => {
    test('prepends both built-in sizes to theme CSS missing them', () => {
        const out = ensureSizeMeta('/* @theme mine */\nsection{width:1280px;height:720px}');
        expect(out).toContain('/* @size 16:9 1280px 720px */');
        expect(out).toContain('/* @size 4:3 960px 720px */');
        expect(out).toContain('/* @theme mine */');
    });

    test('keeps sizes the theme already declares, adds only the missing one', () => {
        const css = '/* @theme mine */\n/* @size 16:9 1600px 900px */\nsection{}';
        const out = ensureSizeMeta(css);
        expect(out).toContain('/* @size 16:9 1600px 900px */');
        expect(out.match(/@size 16:9 /g)).toHaveLength(1); // no duplicate 16:9 meta
        expect(out).toContain('/* @size 4:3 960px 720px */');
    });
});

describe('injectMermaidInitTheme', () => {
    test('is a no-op for the default theme', () => {
        const markdown = '```mermaid\ngraph TD;A-->B;\n```';
        expect(injectMermaidInitTheme(markdown, 'default')).toBe(markdown);
    });

    test('prepends an init directive after the fence, keeping attributes', () => {
        const markdown = '```mermaid {width=700px}\ngraph TD;A-->B;\n```';
        const out = injectMermaidInitTheme(markdown, 'dark');
        expect(out).toBe('```mermaid {width=700px}\n%%{init: {"theme": "dark"}}%%\ngraph TD;A-->B;\n```');
    });

    test('does not double-inject when the diagram sets its own init', () => {
        const markdown = '```mermaid\n%%{init: {"theme": "forest"}}%%\ngraph TD;A-->B;\n```';
        expect(injectMermaidInitTheme(markdown, 'dark')).toBe(markdown);
    });
});

describe('buildCodeThemeCss', () => {
    test('auto produces no CSS', () => {
        expect(buildCodeThemeCss('auto')).toBe('');
    });

    test('every other palette styles the code panel and tokens, scoped to sections', () => {
        for (const theme of ['github', 'github-dark', 'one-dark', 'monokai', 'dracula'] as const) {
            const css = buildCodeThemeCss(theme);
            expect(css).toContain('section pre{');
            expect(css).toContain('section pre code .hljs-keyword');
            // every rule must be scoped to slide sections
            css.split('\n').filter((l) => l.includes('{')).forEach((rule) => {
                expect(rule.startsWith('section ')).toBe(true);
            });
        }
    });
});
