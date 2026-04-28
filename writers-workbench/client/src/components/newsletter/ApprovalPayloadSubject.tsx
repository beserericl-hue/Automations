/**
 * Renders the `subject_line` approval payload — chosen subject + preheader
 * up top, with the LLM's reasoning + alternative subjects collapsed inside
 * a `<details>` (closed by default, per design doc §4.4).
 */

interface SubjectPayload {
  subject_line?: string;
  pre_header_text?: string;
  additional_subject_lines?: string[];
  subject_line_reasoning?: string;
  pre_header_text_reasoning?: string;
}

interface Props {
  payload: Record<string, unknown>;
}

export default function ApprovalPayloadSubject({ payload }: Props) {
  const p = payload as SubjectPayload;
  const additional: string[] = (p.additional_subject_lines ?? []).filter((s): s is string => typeof s === 'string' && s.length > 0);

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Subject</div>
        <h3 className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
          {p.subject_line ? p.subject_line : <span className="text-gray-400">No subject_line in payload.</span>}
        </h3>
        {p.pre_header_text && (
          <p className="mt-2 border-l-2 border-gray-200 pl-3 text-sm italic text-gray-600 dark:border-gray-700 dark:text-gray-300">
            {p.pre_header_text}
          </p>
        )}
      </section>

      {(additional.length > 0 || p.subject_line_reasoning || p.pre_header_text_reasoning) && (
        <details className="rounded-md border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-900">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-200">
            Reasoning + alternatives
          </summary>
          <div className="space-y-3 border-t border-gray-100 px-3 py-2 dark:border-gray-800">
            {additional.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Alternative subjects
                </div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-gray-700 dark:text-gray-300">
                  {additional.map((s: string, i: number) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {p.subject_line_reasoning && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Subject reasoning</div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">
                  {p.subject_line_reasoning}
                </p>
              </div>
            )}
            {p.pre_header_text_reasoning && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Pre-header reasoning</div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-300">
                  {p.pre_header_text_reasoning}
                </p>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
