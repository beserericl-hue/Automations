/**
 * Small colored pill for a newsletter edition. The border picks up
 * the edition's `primary_color` so different editions are
 * visually distinct without us needing a per-edition theme.
 */
import type { NewsletterEdition } from '../../types/database';

interface Props {
  edition: Pick<NewsletterEdition, 'id' | 'display_name' | 'primary_color'>;
  size?: 'sm' | 'md';
}

export default function EditionBadge({ edition, size = 'sm' }: Props) {
  const sz = size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-sm px-2.5 py-1';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${sz} font-medium text-gray-700 dark:text-gray-200`}
      style={{ borderColor: edition.primary_color, backgroundColor: 'transparent' }}
      title={edition.id}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: edition.primary_color }} />
      {edition.display_name}
    </span>
  );
}
