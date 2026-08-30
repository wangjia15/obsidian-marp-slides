import { describe, expect, test } from '@jest/globals';
import { FilePath } from '../src/utilities/filePath';
import { DEFAULT_SETTINGS } from '../src/utilities/settings';

// Minimal stand-ins for the Obsidian objects convertImages touches.
function makeVault(newLinkFormat: 'relative' | 'absolute' = 'relative') {
    return { getConfig: (key: string) => (key === 'newLinkFormat' ? newLinkFormat : undefined) };
}

function makeFile(path: string, vault: any) {
    const parts = path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    return {
        path,
        name: parts[parts.length - 1],
        parent: { path: parentPath },
        vault,
    } as any;
}

// Fake metadataCache: resolves by basename against a known file list.
function makeApp(vault: any, files: string[]) {
    return {
        metadataCache: {
            getFirstLinkpathDest: (linkpath: string) => {
                const wanted = linkpath.split('/').pop();
                const hit = files.find((f) => f.split('/').pop() === wanted || f === linkpath);
                return hit ? makeFile(hit, vault) : null;
            },
        },
    } as any;
}

describe('FilePath.parseSizeHint', () => {
    test('bare width', () => expect(FilePath.parseSizeHint('300')).toBe('w:300'));
    test('width x height', () => expect(FilePath.parseSizeHint('300x200')).toBe('w:300 h:200'));
    test('unicode times separator', () => expect(FilePath.parseSizeHint('300×200')).toBe('w:300 h:200'));
    test('surrounding spaces', () => expect(FilePath.parseSizeHint('  120 x 80 ')).toBe('w:120 h:80'));
    test('prose is not a size hint', () => expect(FilePath.parseSizeHint('a nice chart')).toBeNull());
    test('empty is not a size hint', () => expect(FilePath.parseSizeHint('')).toBeNull());
});

describe('FilePath.convertImages - wiki embeds', () => {
    const vault = makeVault();
    const fp = new FilePath(DEFAULT_SETTINGS);
    const source = makeFile('slides/deck.md', vault);
    const app = makeApp(vault, ['slides/assets/chart.png', 'attachments/photo.png']);

    test('plain wiki embed resolves to a relative markdown link', () => {
        expect(fp.convertImages('![[chart.png]]', source, app)).toBe('![chart.png](assets/chart.png)');
    });

    test('wiki embed with width hint becomes a Marp keyword', () => {
        expect(fp.convertImages('![[chart.png|300]]', source, app)).toBe('![w:300](assets/chart.png)');
    });

    test('wiki embed with WxH hint becomes Marp keywords', () => {
        expect(fp.convertImages('![[chart.png|300x200]]', source, app)).toBe('![w:300 h:200](assets/chart.png)');
    });

    test('wiki embed keeps alt text alongside the size hint', () => {
        expect(fp.convertImages('![[chart.png|Sales|300x200]]', source, app)).toBe(
            '![Sales w:300 h:200](assets/chart.png)'
        );
    });

    test('embed in a parent folder gets a ../ relative path', () => {
        expect(fp.convertImages('![[photo.png|120]]', source, app)).toBe('![w:120](../attachments/photo.png)');
    });

    test('unknown file is left untouched', () => {
        expect(fp.convertImages('![[missing.png]]', source, app)).toBe('![[missing.png]]');
    });

    test('non-image wiki link is left untouched', () => {
        expect(fp.convertImages('![[Some Note]]', source, app)).toBe('![[Some Note]]');
    });
});

describe('FilePath.convertImages - markdown embeds', () => {
    const vault = makeVault();
    const fp = new FilePath(DEFAULT_SETTINGS);
    const source = makeFile('slides/deck.md', vault);
    const app = makeApp(vault, ['slides/assets/chart.png', 'attachments/my photo.png']);

    test('size hint in alt text becomes Marp keywords', () => {
        expect(fp.convertImages('![300x200](assets/chart.png)', source, app)).toBe(
            '![w:300 h:200](assets/chart.png)'
        );
    });

    test('bare filename target is resolved against the vault', () => {
        expect(fp.convertImages('![](chart.png)', source, app)).toBe('![](assets/chart.png)');
    });

    test('URL-encoded spaces are decoded, resolved and re-encoded', () => {
        expect(fp.convertImages('![bg](my%20photo.png)', source, app)).toBe('![bg](../attachments/my%20photo.png)');
    });

    test('leading ./ is stripped before resolving', () => {
        expect(fp.convertImages('![](./assets/chart.png)', source, app)).toBe('![](assets/chart.png)');
    });

    test('remote URLs keep their target but still gain size keywords', () => {
        expect(fp.convertImages('![300](https://example.com/a.png)', source, app)).toBe(
            '![w:300](https://example.com/a.png)'
        );
    });

    test('existing Marp keywords in alt are preserved', () => {
        expect(fp.convertImages('![bg fit](assets/chart.png)', source, app)).toBe('![bg fit](assets/chart.png)');
    });

    test('running twice is idempotent', () => {
        const once = fp.convertImages('![[chart.png|300x200]]', source, app);
        expect(fp.convertImages(once, source, app)).toBe(once);
    });
});

describe('FilePath.convertImages - absolute link format', () => {
    const vault = makeVault('absolute');
    const fp = new FilePath(DEFAULT_SETTINGS);
    const source = makeFile('slides/deck.md', vault);
    const app = makeApp(vault, ['attachments/photo.png']);

    test('resolves to a vault-root-relative path', () => {
        expect(fp.convertImages('![[photo.png|300]]', source, app)).toBe('![w:300](attachments/photo.png)');
    });
});
