import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen, within } from '../../test/test-utils';
import EngineScheduler, { formatInterval, type EngineSchedulerData, type SchedulerJobRow } from './EngineScheduler';

const now = Date.now();
const iso = (offsetS: number) => new Date(now + offsetS * 1000).toISOString();
const row = (o: Partial<SchedulerJobRow> & { name: string }): SchedulerJobRow => ({
  interval_s: 900, singleton: true, ticks: 1, skipped: 0, last_run: iso(-60), last_error: null, next_run: iso(840), health: 'ok', replicas: [], ...o,
});

const DATA: EngineSchedulerData = {
  running: true,
  checked_at: iso(0),
  replicas: [
    { instance: 'rep-a', address: '10.0.0.1', ok: true, running: true },
    { instance: 'rep-b', address: '10.0.0.2', ok: true, running: true },
  ],
  jobs: [
    row({ name: 'ingestion', interval_s: 1800 }),
    row({ name: 'queue-metrics', interval_s: 30, singleton: false, ticks: 40 }),
    row({ name: 'radar', interval_s: 3600, ticks: 0, skipped: 1, last_run: null, next_run: null, health: 'waiting' }),
  ],
};

describe('EngineScheduler', () => {
  it('lists every job with its interval, last run, result, next run and health', async () => {
    renderWithProviders(<EngineScheduler load={async () => DATA} />);
    expect(await screen.findByTestId('scheduler-summary')).toHaveTextContent('3 jobs · 2 of 2 runtime replica(s) answered');
    expect(screen.getByTestId('scheduler-allclear')).toBeInTheDocument();
    const ingestion = screen.getByTestId('scheduler-job-ingestion');
    expect(ingestion).toHaveTextContent('30 min');
    expect(ingestion).toHaveTextContent(/6\ds ago/);
    expect(ingestion).toHaveTextContent('OK');
    expect(ingestion).toHaveTextContent(/in 1[34]m/);
    expect(screen.getByTestId('scheduler-job-queue-metrics')).toHaveTextContent('(per replica)');
    const radar = screen.getByTestId('scheduler-job-radar');
    expect(within(radar).getByText('Waiting')).toBeInTheDocument();
    expect(radar).toHaveTextContent('1 left to another replica');
  });

  it('flags failing and overdue jobs, the error, and a replica that did not answer', async () => {
    renderWithProviders(
      <EngineScheduler
        load={async () => ({
          ...DATA,
          replicas: [DATA.replicas[0], { instance: '10.0.0.2', address: '10.0.0.2', ok: false, error: 'HTTP 401' }],
          jobs: [
            row({ name: 'ingestion', last_error: 'RuntimeError: feed table missing', health: 'failing' }),
            row({ name: 'publish-scheduled', last_run: iso(-4000), health: 'overdue' }),
          ],
        })}
      />,
    );
    expect(await screen.findByTestId('scheduler-alert')).toHaveTextContent('ingestion (failing), publish-scheduled (overdue)');
    expect(screen.getByTestId('scheduler-last-error')).toHaveTextContent('RuntimeError: feed table missing');
    expect(screen.getByTestId('scheduler-unreachable')).toHaveTextContent('10.0.0.2 (HTTP 401)');
    expect(screen.getByTestId('scheduler-job-ingestion')).toHaveAttribute('data-health', 'failing');
  });

  it('says when no job is enabled, and when the load fails', async () => {
    renderWithProviders(<EngineScheduler load={async () => ({ ...DATA, running: false, jobs: [] })} />);
    expect(await screen.findByTestId('scheduler-empty')).toBeInTheDocument();
    expect(screen.getByTestId('scheduler-stopped')).toBeInTheDocument();
  });

  it('shows the error when the scheduler cannot be read', async () => {
    renderWithProviders(<EngineScheduler load={async () => { throw new Error('ENGINE_ADMIN_TOKEN is not set'); }} />);
    expect(await screen.findByTestId('scheduler-error')).toHaveTextContent('ENGINE_ADMIN_TOKEN is not set');
  });

  it('formats intervals', () => {
    expect([30, 300, 900, 3600, 5400].map(formatInterval)).toEqual(['30s', '5 min', '15 min', '1 h', '1.5 h']);
  });
});
