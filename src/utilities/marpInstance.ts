import { Marp } from '@marp-team/marp-core'
import { MathOptions } from '@marp-team/marp-core/types/src/math/math';
import { MarpSlidesSettings } from './settings';

const markdownItContainer = require('markdown-it-container');
const markdownItMark = require('markdown-it-mark');
const markdownItKroki = require('@kazumatu981/markdown-it-kroki');

export function createMarpInstance(settings: MarpSlidesSettings): Marp {
    const marp = new Marp({
        container: { tag: 'div', id: '__marp-vscode' },
        slideContainer: { tag: 'div', 'data-marp-vscode-slide-wrapper': '' },
        html: settings.EnableHTML,
        inlineSVG: {
            enabled: true,
            backdropSelector: false
        },
        math: settings.MathTypesettings as MathOptions,
        minifyCSS: true,
        script: false
    });

    if (settings.EnableMarkdownItPlugins) {
        marp
            .use(markdownItContainer, "container")
            .use(markdownItMark)
            .use(markdownItKroki, { entrypoint: "https://kroki.io" });
    }

    return marp;
}
