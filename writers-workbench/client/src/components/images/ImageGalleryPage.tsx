/**
 * ImageGalleryPage — top-level "Image Gallery" route (/gallery).
 *
 * Shows every image the user has generated across all projects (cover art, chapter
 * art, social media, newsletter sections) by rendering the shared ImageGallery with
 * no projectId. This is the standalone grid marketing-copy.md Scene 1 refers to.
 */
import ImageGallery from './ImageGallery';

export default function ImageGalleryPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Image Gallery</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Every image you&apos;ve generated — cover art, chapter art, social, and newsletter — across all projects.
        </p>
      </div>
      <ImageGallery />
    </div>
  );
}
