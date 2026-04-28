/**
 * StageStrip — 7-phase progress strip for ExecutionStatus (S7).
 *
 * The server emits 9 stage events (gathering / selecting_stories /
 * awaiting_stories_approval / stories_approved / awaiting_subject_approval /
 * subject_approved / writing_segment / segments_done / saved), plus an
 * `error` overlay. The strip groups them into 7 visible phases — a stage's
 * `awaiting_*` and `*_approved` pair collapse into a single approval pill
 * with a sub-state icon, which keeps the strip readable without losing
 * detail. Per design doc §4.1.
 *
 * State per pill:
 *   pending   — not yet reached
 *   active    — current
 *   done      — passed
 *   error     — error overlay landed while this pill was active
 *
 * Approval pills carry an extra sub-state when active:
 *   awaiting  — `awaiting_*` event observed; show hourglass
 *   approved  — `*_approved` event observed; show check
 *
 * `aria-current="step"` lands on the active pill so screen readers
 * announce position.
 */
import type { NewsletterStage } from '../../lib/newsletter/schema';

export type PhaseId =
  | 'gathering'
  | 'selecting'
  | 'stories_approval'
  | 'subject_approval'
  | 'writing'
  | 'assembling'
  | 'saved';

export const PHASE_ORDER: readonly PhaseId[] = [
  'gathering',
  'selecting',
  'stories_approval',
  'subject_approval',
  'writing',
  'assembling',
  'saved',
] as const;

const PHASE_LABEL: Record<PhaseId, string> = {
  gathering: 'Gathering',
  selecting: 'Selecting',
  stories_approval: 'Stories approval',
  subject_approval: 'Subject approval',
  writing: 'Writing',
  assembling: 'Assembling',
  saved: 'Saved',
};

/** Map a server stage value to its visible phase. */
export function phaseForStage(stage: NewsletterStage): PhaseId | null {
  switch (stage) {
    case 'gathering':                  return 'gathering';
    case 'selecting_stories':          return 'selecting';
    case 'awaiting_stories_approval':
    case 'stories_approved':           return 'stories_approval';
    case 'awaiting_subject_approval':
    case 'subject_approved':           return 'subject_approval';
    case 'writing_segment':            return 'writing';
    case 'segments_done':              return 'assembling';
    case 'saved':                      return 'saved';
    case 'error':                      return null; // overlay only
    default:                           return null;
  }
}

interface StageStripProps {
  /** Latest stage observed on this execution. null = no events yet. */
  currentStage: NewsletterStage | null;
  /** When set, shows an error overlay on the phase that was active. */
  error?: { stage: NewsletterStage; detail: string } | null;
  /** Optional: when the most recent approval phase observed sub-state. */
  awaitingApproval?: 'stories' | 'subject' | null;
}

interface PillState {
  phase: PhaseId;
  state: 'pending' | 'active' | 'done' | 'error';
  approvalSubState?: 'awaiting' | 'approved';
}

function pillStates(props: StageStripProps): PillState[] {
  const currentPhase = props.currentStage ? phaseForStage(props.currentStage) : null;
  const errorPhase = props.error ? phaseForStage(props.error.stage) : null;
  const currentIdx = currentPhase ? PHASE_ORDER.indexOf(currentPhase) : -1;
  return PHASE_ORDER.map((phase) => {
    const phaseIdx = PHASE_ORDER.indexOf(phase);
    let state: PillState['state'] = 'pending';
    if (errorPhase === phase) state = 'error';
    else if (phaseIdx < currentIdx) state = 'done';
    else if (phaseIdx === currentIdx) state = 'active';
    // saved is special: when reached, it's done (terminal), not active.
    if (phase === 'saved' && props.currentStage === 'saved') state = 'done';

    let approvalSubState: PillState['approvalSubState'];
    if (state === 'active' || state === 'done') {
      if (phase === 'stories_approval') {
        if (props.currentStage === 'awaiting_stories_approval') approvalSubState = 'awaiting';
        else if (props.currentStage === 'stories_approved' || phaseIdx < currentIdx) approvalSubState = 'approved';
      }
      if (phase === 'subject_approval') {
        if (props.currentStage === 'awaiting_subject_approval') approvalSubState = 'awaiting';
        else if (props.currentStage === 'subject_approved' || phaseIdx < currentIdx) approvalSubState = 'approved';
      }
    }
    return { phase, state, approvalSubState };
  });
}

const STATE_PILL_CLASSES: Record<PillState['state'], string> = {
  pending: 'border-gray-200 bg-gray-50 text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-500',
  active:  'border-brand-500 bg-brand-50 text-brand-700 dark:border-brand-400 dark:bg-brand-950 dark:text-brand-200',
  done:    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300',
  error:   'border-red-400 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/30 dark:text-red-300',
};

export default function StageStrip(props: StageStripProps) {
  const pills = pillStates(props);
  return (
    <ol
      role="list"
      aria-label="Newsletter execution progress"
      className="flex items-stretch gap-2 overflow-x-auto"
    >
      {pills.map((pill) => {
        const ariaCurrent = pill.state === 'active' ? 'step' : undefined;
        const subIcon =
          pill.approvalSubState === 'awaiting' ? '⌛' :
          pill.approvalSubState === 'approved' ? '✓' :
          pill.state === 'done' ? '✓' :
          pill.state === 'error' ? '!' :
          null;
        return (
          <li
            key={pill.phase}
            aria-current={ariaCurrent}
            data-phase={pill.phase}
            data-state={pill.state}
            className={`flex min-w-[120px] flex-1 items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium ${STATE_PILL_CLASSES[pill.state]}`}
            title={pill.state === 'error' && props.error ? props.error.detail : PHASE_LABEL[pill.phase]}
          >
            {subIcon && <span aria-hidden="true">{subIcon}</span>}
            <span className="truncate">{PHASE_LABEL[pill.phase]}</span>
          </li>
        );
      })}
    </ol>
  );
}
