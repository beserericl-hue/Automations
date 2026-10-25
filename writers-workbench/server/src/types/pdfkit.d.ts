// pdfkit ships no types under this module resolution. Only the surface this codebase uses is
// declared — a narrow shim is easier to trust than `any`, and it fails loudly if the API moves.
declare module 'pdfkit' {
  interface TextOptions {
    width?: number;
    align?: 'left' | 'center' | 'right' | 'justify';
    indent?: number;
    lineGap?: number;
    paragraphGap?: number;
    characterSpacing?: number;
    lineBreak?: boolean;
    continued?: boolean;
  }
  interface PageMargins {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }
  class PDFDocument {
    constructor(options?: {
      size?: [number, number] | string;
      margins?: PageMargins;
      autoFirstPage?: boolean;
      bufferPages?: boolean;
      info?: Record<string, string>;
    });
    /** `dictionary.data` is the raw page dictionary: where TrimBox and BleedBox are set. */
    page: { margins: PageMargins; dictionary: { data: Record<string, unknown> } };
    x: number;
    y: number;
    translate(x: number, y: number): this;
    addPage(): this;
    registerFont(name: string, src: Buffer | string): this;
    font(name: string): this;
    fontSize(size: number): this;
    fillColor(color: string): this;
    text(text: string, x?: number, y?: number, options?: TextOptions): this;
    moveDown(lines?: number): this;
    image(src: Buffer, x?: number, y?: number, options?: { width?: number; height?: number }): this;
    bufferedPageRange(): { start: number; count: number };
    switchToPage(n: number): this;
    on(event: 'data', cb: (chunk: Buffer) => void): this;
    on(event: 'end', cb: () => void): this;
    on(event: 'pageAdded', cb: () => void): this;
    end(): void;
  }
  export default PDFDocument;
}
