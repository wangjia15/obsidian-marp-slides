import { describe, expect, test } from '@jest/globals';
import { rgbToHex, isTransparent, pxToIn, pxToPt } from '../src/utilities/units';

describe('rgbToHex', () => {
  test('converts rgb() to uppercase hex', () => {
    expect(rgbToHex('rgb(255, 87, 51)')).toBe('FF5733');
  });

  test('converts rgba() ignoring alpha', () => {
    expect(rgbToHex('rgba(0, 128, 255, 0.5)')).toBe('0080FF');
  });

  test('pads single-digit channels', () => {
    expect(rgbToHex('rgb(0, 0, 0)')).toBe('000000');
    expect(rgbToHex('rgb(1, 2, 3)')).toBe('010203');
  });

  test('falls back to black for unparseable input', () => {
    expect(rgbToHex('hotpink')).toBe('000000');
  });
});

describe('isTransparent', () => {
  test('detects the transparent keyword', () => {
    expect(isTransparent('transparent')).toBe(true);
  });

  test('detects zero-alpha rgba', () => {
    expect(isTransparent('rgba(0, 0, 0, 0)')).toBe(true);
  });

  test('treats opaque colors as not transparent', () => {
    expect(isTransparent('rgb(255, 255, 255)')).toBe(false);
    expect(isTransparent('rgba(10, 20, 30, 0.4)')).toBe(false);
  });
});

describe('px conversions', () => {
  test('pxToIn converts at 96 dpi', () => {
    expect(pxToIn(96)).toBe(1);
    expect(pxToIn(1280)).toBeCloseTo(13.333, 3);
  });

  test('pxToPt converts at 0.75pt per px', () => {
    expect(pxToPt(16)).toBe(12);
  });
});
