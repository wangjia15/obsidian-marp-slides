import { describe, expect, test } from '@jest/globals';
import { deflateSync } from 'zlib';
import { extractMermaidDiagrams, parseMermaidDimensions, applyMermaidStyling } from '../src/utilities/mermaid';

const encode = (code: string) => deflateSync(code, { level: 9 }).toString('base64url');

describe('extractMermaidDiagrams', () => {
  test('returns empty array when there are no mermaid fences', () => {
    expect(extractMermaidDiagrams('# Title\n\nplain text\n')).toEqual([]);
  });

  test('extracts every mermaid fence body, including ones with attributes', () => {
    const markdown = [
      '# Deck',
      '```mermaid',
      'graph TD;A-->B;',
      '```',
      'text between',
      '```mermaid {width=700px}',
      'sequenceDiagram',
      '```',
    ].join('\n');

    expect(extractMermaidDiagrams(markdown)).toEqual([
      'graph TD;A-->B;\n',
      'sequenceDiagram\n',
    ]);
  });

  test('ignores non-mermaid fences', () => {
    const markdown = '```js\nconsole.log(1);\n```\n';
    expect(extractMermaidDiagrams(markdown)).toEqual([]);
  });
});

describe('parseMermaidDimensions', () => {
  test('strips attribute block and records dimensions keyed by encoded code', () => {
    const code = 'graph TD;A-->B;\n';
    const markdown = `\`\`\`mermaid {width=700px height=50%}\n${code}\`\`\``;

    const { processedMarkdown, dimensionMap } = parseMermaidDimensions(markdown);

    expect(processedMarkdown).toBe(`\`\`\`mermaid\n${code}\`\`\``);
    expect(dimensionMap.get(encode(code))).toEqual({ width: '700px', height: '50%' });
  });

  test('leaves fences without attributes untouched', () => {
    const markdown = '```mermaid\ngraph TD;\n```';
    const { processedMarkdown, dimensionMap } = parseMermaidDimensions(markdown);

    expect(processedMarkdown).toBe(markdown);
    expect(dimensionMap.size).toBe(0);
  });

  test('attribute block without width/height is dropped without a map entry', () => {
    const markdown = '```mermaid {theme=dark}\ngraph TD;\n```';
    const { processedMarkdown, dimensionMap } = parseMermaidDimensions(markdown);

    expect(processedMarkdown).toBe('```mermaid\ngraph TD;\n```');
    expect(dimensionMap.size).toBe(0);
  });
});

describe('applyMermaidStyling', () => {
  const encoded = 'abc123';
  const embedHtml = `<marp-auto-scaling data-downscale-only><embed class="kroki" src="https://kroki.io/mermaid/svg/${encoded}" /></marp-auto-scaling>`;

  test('returns input unchanged when no sizing is requested', () => {
    const { html, css } = applyMermaidStyling(embedHtml, 'body{}', new Map(), '', '');
    expect(html).toBe(embedHtml);
    expect(css).toBe('body{}');
  });

  test('unwraps marp-auto-scaling and applies per-diagram dimensions', () => {
    const dimensionMap = new Map([[encoded, { width: '700px', height: '400px' }]]);
    const { html } = applyMermaidStyling(embedHtml, '', dimensionMap, '', '');

    expect(html).not.toContain('<marp-auto-scaling');
    expect(html).toContain('style="width:700px;height:400px"');
    expect(html).toContain(`src="https://kroki.io/mermaid/svg/${encoded}"`);
  });

  test('adds global max-width/max-height CSS when defaults are set', () => {
    const { html, css } = applyMermaidStyling(embedHtml, '', new Map(), '80%', '60%');

    expect(html).not.toContain('<marp-auto-scaling');
    expect(css).toContain('p.kroki-image-container embed,p.kroki-image-container img{max-width:80%;max-height:60%}');
  });

  test('keeps diagrams without dimensions wrapped when only other diagrams are sized', () => {
    const dimensionMap = new Map([['other-diagram', { width: '10px' }]]);
    const { html } = applyMermaidStyling(embedHtml, '', dimensionMap, '', '');
    expect(html).toBe(embedHtml);
  });
});
