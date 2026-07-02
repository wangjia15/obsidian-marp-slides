const PX_PER_INCH = 96;

export function rgbToHex(rgb: string): string {
    const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return '000000';
    return [m[1], m[2], m[3]]
        .map((v) => Number(v).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase();
}

export function isTransparent(rgb: string): boolean {
    const m = rgb.match(/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\)/);
    return rgb === 'transparent' || (!!m && parseFloat(m[1]) === 0);
}

export function pxToIn(px: number): number {
    return px / PX_PER_INCH;
}

export function pxToPt(px: number): number {
    return px * 0.75;
}
