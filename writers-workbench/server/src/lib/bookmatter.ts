/**
 * Front and back matter — the pages that make a manuscript a book.
 *
 * The exports produced a title page and 96 chapters. That is a manuscript. A book opens with a half
 * title, a title page and a copyright page, and closes with an author's note and an about-the-author.
 * Of those the copyright page is the only one that is not optional: it carries the rights assertion,
 * the ISBN and — for fiction — the disclaimer that keeps a novel about real places and a real
 * people from reading as a claim about real individuals.
 *
 * Format-neutral by design. Each section is a title plus blocks, and the EPUB and the print PDF each
 * render that structure their own way: the EPUB as XHTML with a nav entry, the PDF as a recto page
 * with the typographic conventions print expects. Writing the matter twice, once per format, is how
 * the copyright line in the paperback stops matching the one in the ebook.
 *
 * A multi-volume series needs this to be volume-aware. Volume 2's half title says "Volume Two", its
 * copyright page names the volume, and its "also by" lists its siblings — which is the difference
 * between three books and the same book printed three times.
 */

export type MatterKind =
  | 'half-title'
  | 'title'
  | 'copyright'
  | 'dedication'
  | 'epigraph'
  | 'authors-note'
  | 'acknowledgements'
  | 'about-the-author'
  | 'also-by'
  | 'series'
  | 'excerpt';

export interface MatterBlock {
  text: string;
  /** How this line is set. `centre` is the default for front matter. */
  style?: 'centre' | 'left' | 'small' | 'italic' | 'title' | 'author' | 'rule';
}

export interface MatterSection {
  kind: MatterKind;
  /** Shown as a heading. Empty for pages that carry no heading, like the half title. */
  heading: string;
  blocks: MatterBlock[];
  /** Front matter is traditionally unnumbered and excluded from the running heads. */
  front: boolean;
  /** Include in the table of contents. A half title and a copyright page are not listed. */
  inToc: boolean;
}

export interface VolumeInfo {
  index: number; // 1-based
  total: number;
  /** The volume's own title, when it has one beyond "Volume Two". */
  subtitle?: string;
  firstChapter?: number;
  lastChapter?: number;
  /**
   * A SERIES rather than one book in parts: the series is named, and each book can carry its own
   * title. When `bookTitle` is set it is the book's title everywhere — cover, title page, copyright
   * page, listing — and the series is the line under it ("Book One of The Ossuary").
   */
  seriesName?: string;
  bookTitle?: string;
  /** Every book of the series, in reading order, for the series page. */
  books?: { index: number; title: string; hook?: string }[];
  /** The opening chapter of the next book, printed after this one ends. */
  excerpt?: { bookIndex: number; bookTitle: string; ownTitle?: boolean; chapterTitle: string; text: string };
}

export interface BookMatterOptions {
  title: string;
  author: string;
  /** Defaults to the current year. */
  copyrightYear?: number;
  publisher?: string;
  isbn?: string;
  edition?: string;
  dedication?: string;
  epigraph?: { text: string; attribution?: string };
  authorsNote?: string;
  acknowledgements?: string;
  aboutTheAuthor?: string;
  /** Other titles, for the "also by" page. A series lists its own siblings. */
  alsoBy?: string[];
  volume?: VolumeInfo;
  /** Fiction gets the disclaimer; a memoir or history must not claim to be invented. */
  fiction?: boolean;
}

const ROMAN = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

export function volumeLabel(index: number): string {
  return `Volume ${ROMAN[index] ?? index}`;
}

export function bookLabel(index: number): string {
  return `Book ${ROMAN[index] ?? index}`;
}

/**
 * What goes on the cover, the title page and the KDP title field: the book's own title in a
 * series, otherwise "The Ossuary: Volume Two".
 */
export function volumeTitle(title: string, volume?: VolumeInfo): string {
  if (!volume || volume.total <= 1) return title;
  if (volume.bookTitle?.trim()) return volume.bookTitle.trim();
  // A series book with no title chosen yet: "The Ossuary: Book One", not "Volume One".
  if (volume.seriesName?.trim()) return `${volume.seriesName.trim()}: ${bookLabel(volume.index)}`;
  const sub = volume.subtitle?.trim();
  return sub ? `${title}: ${sub}` : `${title}: ${volumeLabel(volume.index)}`;
}

/**
 * The fiction disclaimer, in its standard form.
 *
 * This book is set among a real people in real places, which is exactly the case the disclaimer
 * exists for: it has to separate the invented individuals from the documented community without
 * disclaiming the history itself.
 */
/**
 * "Book One of The Ossuary" — the series line under a series book's own title. Empty for a volume,
 * and for a series book with no title yet, whose title already says it ("The Ossuary: Book One").
 */
export function seriesLine(volume?: VolumeInfo): string {
  if (!volume || volume.total <= 1 || !volume.seriesName?.trim() || !volume.bookTitle?.trim()) return '';
  return `${bookLabel(volume.index)} of ${volume.seriesName.trim()}`;
}

const FICTION_DISCLAIMER =
  'This is a work of fiction. While it draws on documented history, the characters and the events ' +
  'of their lives are the product of the author’s imagination. Any resemblance to actual ' +
  'persons, living or dead, is coincidental.';

function copyrightBlocks(o: BookMatterOptions): MatterBlock[] {
  const year = o.copyrightYear ?? new Date().getUTCFullYear();
  const blocks: MatterBlock[] = [
    { text: volumeTitle(o.title, o.volume), style: 'italic' },
    ...(seriesLine(o.volume) ? [{ text: seriesLine(o.volume), style: 'small' as const }] : []),
    { text: `Copyright © ${year} by ${o.author}`, style: 'small' },
    { text: 'All rights reserved.', style: 'small' },
    {
      text:
        'No part of this book may be reproduced in any form or by any electronic or mechanical ' +
        'means, including information storage and retrieval systems, without permission in writing ' +
        'from the publisher, except by a reviewer who may quote brief passages in a review.',
      style: 'small',
    },
  ];
  if (o.fiction !== false) blocks.push({ text: FICTION_DISCLAIMER, style: 'small' });
  if (o.isbn) blocks.push({ text: `ISBN: ${o.isbn}`, style: 'small' });
  if (o.edition) blocks.push({ text: o.edition, style: 'small' });
  if (o.publisher) blocks.push({ text: o.publisher, style: 'small' });
  return blocks;
}

/**
 * The front matter, in the order a printed book uses it.
 *
 * Half title, title, copyright, dedication, epigraph. Everything after the copyright page is
 * optional and is omitted entirely rather than left as an empty page — a blank "Dedication" heading
 * is worse than no dedication.
 */
export function frontMatter(o: BookMatterOptions): MatterSection[] {
  const full = volumeTitle(o.title, o.volume);
  const series = seriesLine(o.volume);
  const isSeries = Boolean(o.volume && o.volume.total > 1 && o.volume.seriesName);
  // A series book's half title and title page carry ITS title, with the series beneath. A volume
  // of one book keeps the book's title and names the volume.
  const sections: MatterSection[] = [
    {
      kind: 'half-title',
      heading: '',
      blocks: [{ text: isSeries ? full : o.title, style: 'title' }],
      front: true,
      inToc: false,
    },
    {
      kind: 'title',
      heading: '',
      blocks: [
        { text: isSeries ? full : o.title, style: 'title' },
        ...(isSeries
          ? series
            ? [{ text: series, style: 'italic' as const }]
            : []
          : o.volume && o.volume.total > 1
            ? [
                {
                  text: o.volume.subtitle?.trim() || volumeLabel(o.volume.index),
                  style: 'italic' as const,
                },
              ]
            : []),
        { text: o.author, style: 'author' },
        ...(o.publisher ? [{ text: o.publisher, style: 'small' as const }] : []),
      ],
      front: true,
      inToc: false,
    },
    {
      kind: 'copyright',
      heading: '',
      blocks: copyrightBlocks({ ...o, title: full }),
      front: true,
      inToc: false,
    },
  ];

  if (o.dedication?.trim()) {
    sections.push({
      kind: 'dedication',
      heading: '',
      blocks: [{ text: o.dedication.trim(), style: 'italic' }],
      front: true,
      inToc: false,
    });
  }
  if (o.epigraph?.text?.trim()) {
    const blocks: MatterBlock[] = [{ text: o.epigraph.text.trim(), style: 'italic' }];
    if (o.epigraph.attribution?.trim()) {
      blocks.push({ text: `— ${o.epigraph.attribution.trim()}`, style: 'small' });
    }
    sections.push({ kind: 'epigraph', heading: '', blocks, front: true, inToc: false });
  }
  return sections;
}

/**
 * The back matter.
 *
 * The author's note matters more than usual for a book built on documented history: it is where the
 * record is separated from the invention, and a reader who has just spent six hundred pages among
 * real people and real places is owed that line.
 */
export function backMatter(o: BookMatterOptions): MatterSection[] {
  const sections: MatterSection[] = [];
  const para = (s: string): MatterBlock[] =>
    s
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ text: p, style: 'left' as const }));

  if (o.authorsNote?.trim()) {
    sections.push({
      kind: 'authors-note',
      heading: "Author\u2019s Note",
      blocks: para(o.authorsNote),
      front: false,
      inToc: true,
    });
  }
  if (o.acknowledgements?.trim()) {
    sections.push({
      kind: 'acknowledgements',
      heading: 'Acknowledgements',
      blocks: para(o.acknowledgements),
      front: false,
      inToc: true,
    });
  }
  if (o.aboutTheAuthor?.trim()) {
    sections.push({
      kind: 'about-the-author',
      heading: 'About the Author',
      blocks: para(o.aboutTheAuthor),
      front: false,
      inToc: true,
    });
  }
  const others = [...(o.alsoBy ?? [])];
  const seriesBooks = o.volume && o.volume.total > 1 && o.volume.seriesName ? o.volume.books ?? [] : [];
  if (seriesBooks.length) {
    // The series page: every book in reading order, this one marked. It is what tells a reader who
    // has just finished that there is more, and in what order.
    const blocks: MatterBlock[] = [];
    for (const b of seriesBooks) {
      const here = b.index === o.volume!.index ? '  (this book)' : '';
      const name = b.title?.trim();
      blocks.push({ text: `${bookLabel(b.index)}${name ? `: ${name}` : ''}${here}`, style: 'centre' });
      if (b.hook?.trim()) blocks.push({ text: b.hook.trim(), style: 'small' });
    }
    sections.push({ kind: 'series', heading: o.volume!.seriesName!.trim(), blocks, front: false, inToc: true });
  } else if (o.volume && o.volume.total > 1) {
    // A volume's siblings are listed automatically — three books that do not mention each other are
    // three books nobody finishes.
    for (let i = 1; i <= o.volume.total; i += 1) {
      if (i === o.volume.index) continue;
      others.push(volumeTitle(o.title, { ...o.volume, index: i, subtitle: undefined }));
    }
  }
  if (others.length) {
    sections.push({
      kind: 'also-by',
      heading: `Also by ${o.author}`,
      blocks: others.map((t) => ({ text: t, style: 'centre' as const })),
      front: false,
      inToc: true,
    });
  }
  // Last of all, the first chapter of the next book: the reader who reached the end wanted more,
  // and this is where they get it.
  const ex = o.volume?.excerpt;
  if (ex?.text?.trim()) {
    const next = o.volume && ex.ownTitle ? { ...o.volume, index: ex.bookIndex, bookTitle: ex.bookTitle } : undefined;
    sections.push({
      kind: 'excerpt',
      heading: `Read on: ${ex.bookTitle}`,
      blocks: [
        ...(seriesLine(next) ? [{ text: seriesLine(next), style: 'italic' as const }] : []),
        ...(ex.chapterTitle ? [{ text: ex.chapterTitle, style: 'centre' as const }] : []),
        // A scene break in the manuscript ("---" on its own line) prints as a centred "* * *".
        ...para(ex.text.replace(/^[ \t]*-{3,}[ \t]*$/gm, '* * *')).map((b) =>
          b.text === '* * *' ? { ...b, style: 'centre' as const } : b,
        ),
      ],
      front: false,
      inToc: true,
    });
  }
  return sections;
}

/** Everything a reader needs that is not a chapter, in reading order. */
export function bookMatter(o: BookMatterOptions): { front: MatterSection[]; back: MatterSection[] } {
  return { front: frontMatter(o), back: backMatter(o) };
}

/** What is missing before this is publishable, in the order it matters. */
export function missingMatter(o: BookMatterOptions): string[] {
  const gaps: string[] = [];
  if (!o.author?.trim()) gaps.push('author name — the copyright line and the byline need it');
  if (!o.isbn?.trim()) {
    gaps.push('ISBN — free from KDP for print, or supply your own (ebooks do not need one)');
  }
  if (!o.publisher?.trim()) gaps.push('publisher imprint (optional; your own name is fine)');
  if (!o.authorsNote?.trim()) {
    gaps.push("author's note — for a book built on documented history, close to obligatory");
  }
  if (!o.aboutTheAuthor?.trim()) gaps.push('about-the-author paragraph');
  if (!o.dedication?.trim()) gaps.push('dedication (optional)');
  return gaps;
}
