/**
 * A formatting block: a run of paragraphs set apart in its own look (a letter, a poem, an epigraph)
 * without changing the rest of the chapter.
 *
 * Saved as `<div data-format-block data-font=… data-size=… …>` around ordinary paragraphs, with the same
 * look in an inline style so the editor shows it as it prints. The EPUB and print exports read those
 * data attributes (server/src/lib/html-prose.ts).
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { BLOCK_DEFAULTS, blockCss, cleanBlockStyle, type BlockStyle } from '../../lib/blockStyle';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    formatBlock: {
      /** Wrap the selected paragraphs in a block with this look. */
      setFormatBlock: (style: Partial<BlockStyle>) => ReturnType;
      /** Change the look of the block the cursor is in. */
      updateFormatBlock: (style: Partial<BlockStyle>) => ReturnType;
      /** Take the paragraphs out of their block; the text stays. */
      unsetFormatBlock: () => ReturnType;
    };
  }
}

const attr = (name: string, def: unknown) => ({
  default: def,
  parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? def,
  renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: String(attrs[name] ?? def) }),
});

export const FormatBlock = Node.create({
  name: 'formatBlock',
  group: 'block',
  content: '(paragraph | heading | blockquote)+',
  defining: true,

  addAttributes() {
    return {
      preset: { ...attr('preset', ''), renderHTML: (a: Record<string, unknown>) => (a.preset ? { 'data-preset': String(a.preset) } : {}) },
      font: attr('font', BLOCK_DEFAULTS.font),
      size: attr('size', BLOCK_DEFAULTS.size),
      align: attr('align', BLOCK_DEFAULTS.align),
      indent: attr('indent', BLOCK_DEFAULTS.indent),
      spacing: attr('spacing', BLOCK_DEFAULTS.spacing),
      italic: attr('italic', BLOCK_DEFAULTS.italic),
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-format-block]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const style = cleanBlockStyle(node.attrs);
    return ['div', mergeAttributes(HTMLAttributes, { 'data-format-block': '', style: blockCss(style) }), 0];
  },

  addCommands() {
    return {
      setFormatBlock:
        (style) =>
        ({ commands }) =>
          commands.wrapIn(this.name, cleanBlockStyle({ ...BLOCK_DEFAULTS, ...style })),
      updateFormatBlock:
        (style) =>
        ({ commands, editor }) =>
          commands.updateAttributes(this.name, cleanBlockStyle({ ...cleanBlockStyle(editor.getAttributes(this.name)), ...style })),
      unsetFormatBlock:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
