import { EmptyState } from '../shared/Skeleton';

export default function IngestionBrowser() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Ingestion browser</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Inspect the raw markdown / html scraped by the daily ingestion run.
        </p>
      </header>

      <EmptyState
        title="Ingestion browser — Phase 2b"
        description="Phase 2b ships the date-prefix browser, content_ingestion_v2 row inspector, and stored-blob viewer wired to /api/ingestion/get/:key."
      />
    </div>
  );
}
