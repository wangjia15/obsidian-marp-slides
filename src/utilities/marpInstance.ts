import { Marp, MarpOptions } from '@marp-team/marp-core'
import { MarpSlidesSettings } from './settings';
import { normalizeKrokiUrl } from './mermaid';

const markdownItContainer = require('markdown-it-container');
const markdownItMark = require('markdown-it-mark');
const markdownItKroki = require('@kazumatu981/markdown-it-kroki');

export function createMarpInstance(settings: MarpSlidesSettings): Marp {
    const marp = new Marp({
        container: { tag: 'div', id: '__marp-vscode' },
        slideContainer: { tag: 'div', 'data-marp-vscode-slide-wrapper': '' },
        // Local mermaid rendering injects pre-rendered inline SVG as raw HTML, so
        // HTML passthrough must be on for that mode regardless of EnableHTML.
        html: settings.EnableHTML || settings.MermaidRenderMode === 'local',
        inlineSVG: {
            enabled: true,
            backdropSelector: false
        },
        math: settings.MathTypesettings as MarpOptions['math'],
        minifyCSS: true,
        script: false
    });

    if (settings.EnableMarkdownItPlugins) {
        marp
            .use(markdownItContainer, "container")
            .use(markdownItMark)
            .use(markdownItKroki, { entrypoint: normalizeKrokiUrl(settings.KrokiServerUrl) });
    }

    return marp;
}
