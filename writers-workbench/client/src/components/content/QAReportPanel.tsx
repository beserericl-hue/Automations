import { useState } from 'react';
import type { QAReport, QACheck } from '../../types/database';

interface QAReportPanelProps {
  metadata: Record<string, unknown>;
}

export default function QAReportPanel({ metadata }: QAReportPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const report = metadata?.qa_report as QAReport | undefined;

  if (!report || !report.checks?.length) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-3 dark:border-gray-700">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          No consistency report available
        </div>
      </div>
    );
  }

  const passCount = report.checks.filter((c) => c.status === 'PASS').length;
  const totalCount = report.checks.length;
  const allPass = passCount === totalCount;

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/50 transition"
      >
        <div className="flex items-center gap-2">
          <QAStatusIcon allPass={allPass} />
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            Q/A Consistency Report
          </span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            allPass
              ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
          }`}>
            {passCount}/{totalCount} passed
          </span>
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded checks list */}
      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {report.checks.map((check, i) => (
              <CheckRow key={i} check={check} />
            ))}
          </div>
          {report.generated_at && (
            <div className="px-4 py-2 text-xs text-gray-400 bg-gray-50 dark:bg-gray-800/30">
              Report generated: {new Date(report.generated_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: QACheck }) {
  const isPass = check.status === 'PASS';
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      {isPass ? (
        <svg className="h-4 w-4 mt-0.5 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-4 w-4 mt-0.5 text-yellow-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{check.name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{check.details}</p>
      </div>
    </div>
  );
}

function QAStatusIcon({ allPass }: { allPass: boolean }) {
  if (allPass) {
    return (
      <svg className="h-5 w-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  return (
    <svg className="h-5 w-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}
