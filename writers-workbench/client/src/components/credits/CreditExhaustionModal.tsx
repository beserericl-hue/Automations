// Sprint 8 (S8-6): credit exhaustion modal. Fires when chat / generation routes
// return 402 INSUFFICIENT_CREDITS. Single CTA: "Buy more credits" → /credits.
//
// No "are you sure" confirmation gate before spending — credits are silently
// deducted on each successful operation. The modal only appears once the user
// is actually out.

import { Link } from 'react-router-dom';

export interface CreditExhaustionModalProps {
  open: boolean;
  onClose: () => void;
  /** Credits the failing op needed (from 402 body). */
  creditsRequired?: number;
  /** Credits the user actually has. */
  creditsRemaining?: number;
  /** Free-form description of what the user tried to do. */
  attemptedOperation?: string;
}

export default function CreditExhaustionModal({
  open,
  onClose,
  creditsRequired,
  creditsRemaining,
  attemptedOperation,
}: CreditExhaustionModalProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="credit-exhaustion-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.66 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.34.19 3 1.73 3z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 id="credit-exhaustion-title" className="text-lg font-bold text-gray-900 dark:text-white">
              Out of credits
            </h2>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {attemptedOperation ? (
                <>This {attemptedOperation} would take </>
              ) : (
                <>This operation would take </>
              )}
              <strong>{creditsRequired ?? 'more'}</strong> credit{creditsRequired === 1 ? '' : 's'}, but
              you only have <strong>{creditsRemaining ?? 0}</strong> remaining.
            </p>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Buy more credits to keep going. They never expire — they're added on top of your monthly allowance.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Not now
          </button>
          <Link
            to="/credits"
            onClick={onClose}
            className="rounded-lg bg-blue-600 px-4 py-2 text-center text-sm font-semibold text-white hover:bg-blue-700"
          >
            Buy more credits
          </Link>
        </div>
      </div>
    </div>
  );
}
