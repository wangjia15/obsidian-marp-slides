import { describe, expect, test } from '@jest/globals';
import { InlineRun, mergeInlineRuns } from '../src/utilities/inlineRuns';

const baseRun = (overrides: Partial<InlineRun>): InlineRun => ({
  text: '',
  color: 'rgb(0, 0, 0)',
  fontWeight: 'normal',
  fontStyle: 'normal',
  fontSize: 16,
  ...overrides,
});

describe('mergeInlineRuns', () => {
  test('merges adjacent runs with identical style', () => {
    const merged = mergeInlineRuns([
      baseRun({ text: 'hel' }),
      baseRun({ text: 'lo ' }),
      baseRun({ text: 'world' }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('hello world');
  });

  test('keeps runs apart when any style property differs', () => {
    const merged = mergeInlineRuns([
      baseRun({ text: 'plain ' }),
      baseRun({ text: 'bold', fontWeight: '700' }),
      baseRun({ text: ' red', color: 'rgb(255, 0, 0)' }),
      baseRun({ text: ' small', fontSize: 12 }),
      baseRun({ text: ' hi', backgroundColor: 'rgb(255, 255, 0)' }),
      baseRun({ text: ' link', href: 'https://example.com' }),
      baseRun({ text: ' u', underline: true }),
    ]);
    expect(merged).toHaveLength(7);
  });

  test('does not merge identical styles across an intervening different run', () => {
    const merged = mergeInlineRuns([
      baseRun({ text: 'a' }),
      baseRun({ text: 'b', fontWeight: '700' }),
      baseRun({ text: 'c' }),
    ]);
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });

  test('treats present and absent optional properties as different styles', () => {
    const merged = mergeInlineRuns([
      baseRun({ text: 'a', backgroundColor: undefined }),
      baseRun({ text: 'b', backgroundColor: 'rgb(255, 255, 0)' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  test('does not modify the input runs', () => {
    const input = [baseRun({ text: 'a' }), baseRun({ text: 'b' })];
    mergeInlineRuns(input);
    expect(input[0].text).toBe('a');
    expect(input).toHaveLength(2);
  });

  test('returns an empty array for empty input', () => {
    expect(mergeInlineRuns([])).toEqual([]);
  });
});
