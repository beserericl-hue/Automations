/**
 * The look of a formatting block (a letter, a poem, an epigraph): the one definition the editor and the
 * preset list share. The server has the same mapping (server/src/lib/html-prose.ts) for the EPUB and the
 * print file; the values and limits here must stay the same as there.
 */
export type BlockFont = 'serif' | 'sans' | 'typewriter' | 'handwriting';
export type BlockAlign = 'left' | 'center' | 'right' | 'justify';

export interface BlockStyle {
  preset?: string;
  font: BlockFont;
  /** Percent of the body size. */
  size: number;
  align: BlockAlign;
  /** Left indent in em. */
  indent: number;
  /** Line height. */
  spacing: number;
  italic: boolean;
}

export const BLOCK_DEFAULTS: BlockStyle = { font: 'serif', size: 100, align: 'left', indent: 0, spacing: 1.5, italic: false };

export const BLOCK_FONTS: { value: BlockFont; label: string; stack: string }[] = [
  { value: 'serif', label: 'Serif', stack: "Georgia, 'Times New Roman', serif" },
  { value: 'sans', label: 'Sans', stack: "'Helvetica Neue', Arial, sans-serif" },
  { value: 'typewriter', label: 'Typewriter', stack: "'Courier New', Courier, monospace" },
  { value: 'handwriting', label: 'Handwriting', stack: "'Segoe Script', 'Bradley Hand', cursive" },
];

export const BLOCK_LIMITS = { size: [70, 150], indent: [0, 6], spacing: [1, 3] } as const;

const clamp = (v: unknown, [lo, hi]: readonly [number, number] | readonly number[], d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function cleanBlockStyle(raw: Partial<Record<keyof BlockStyle, unknown>>): BlockStyle {
  const font = String(raw.font ?? '') as BlockFont;
  const align = String(raw.align ?? '') as BlockAlign;
  return {
    ...(raw.preset ? { preset: String(raw.preset).slice(0, 60) } : {}),
    font: BLOCK_FONTS.some((f) => f.value === font) ? font : BLOCK_DEFAULTS.font,
    size: clamp(raw.size, BLOCK_LIMITS.size, BLOCK_DEFAULTS.size),
    align: ['left', 'center', 'right', 'justify'].includes(align) ? align : BLOCK_DEFAULTS.align,
    indent: clamp(raw.indent, BLOCK_LIMITS.indent, BLOCK_DEFAULTS.indent),
    spacing: clamp(raw.spacing, BLOCK_LIMITS.spacing, BLOCK_DEFAULTS.spacing),
    italic: raw.italic === true || raw.italic === 'true',
  };
}

export function blockCss(style: BlockStyle): string {
  const stack = BLOCK_FONTS.find((f) => f.value === style.font)!.stack;
  return [
    `font-family:${stack}`,
    `font-size:${style.size}%`,
    `text-align:${style.align}`,
    `margin:1em 0 1em ${style.indent}em`,
    `line-height:${style.spacing}`,
    style.italic ? 'font-style:italic' : '',
  ]
    .filter(Boolean)
    .join(';');
}
