import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import EngineFleet, { type EngineFleetData } from './EngineFleet';

const now = Math.round(Date.now() / 1000);

const DATA: EngineFleetData = {
  served_by: 'rep-a',
  gateway_served_by: 'gw-b',
  server_sees_gateway_addresses: 2,
  gateway_sees_runtime_addresses: 2,
  instances: [
    { service: 'gateway', instance: 'gw-a', started_at: now - 600, last_seen: now - 5, requests_served: 42 },
    { service: 'gateway', instance: 'gw-b', started_at: now - 600, last_seen: now - 5, requests_served: 40 },
    { service: 'orchestrator', instance: 'rep-a', last_seen: now - 10, running: { 'engine-heavy': 2, 'engine-interactive': 0 } },
    { service: 'orchestrator', instance: 'rep-b', last_seen: now - 10, draining: true, running: { 'engine-heavy': 1 } },
  ],
  instance_counts: { gateway: 2, orchestrator: 2 },
  verdict: 'tpm_bound',
  reason: 'engine-heavy: 13 waiting',
  queues: [
    { queue: 'engine-heavy', depth: 16, running: 3, waiting: 13, max_jobs: 16, saturation: 0.188, oldest_wait_s: 420, instances: 2 },
  ],
  budget_stalls_last_minute: 4,
  autoscale: {
    refusal: null,
    config: { enabled: true, min_replicas: 2, max_replicas: 4, cooldown_s: 300, environment_name: 'develop' },
    state: { last_action: 'hold', last_reason: 'tpm_bound: another replica would share the same token budget (B9)', last_current: 2, last_target: 2, last_tick_at: now - 30 },
  },
};

describe('EngineFleet', () => {
  it('shows the replica counts, the verdict in words, the autoscaler and every instance', async () => {
    renderWithProviders(<EngineFleet load={async () => DATA} />);
    expect(await screen.findByTestId('fleet-runtime-count')).toHaveTextContent('2');
    expect(screen.getByTestId('fleet-gateway-count')).toHaveTextContent('2');
    expect(screen.getByText(/More replicas will not help/)).toBeInTheDocument();
    expect(screen.getByTestId('fleet-autoscale-on')).toHaveTextContent('2 to 4 runtime replicas');
    expect(screen.getByTestId('fleet-autoscale-on')).toHaveTextContent('(2 → 2)');
    expect(screen.getByText('draining')).toBeInTheDocument();
    expect(screen.getByText('42 requests')).toBeInTheDocument();
    expect(screen.getByText('2 worker(s) · 16 slots')).toBeInTheDocument();
    expect(screen.getByTestId('fleet-spread')).toHaveTextContent('2 gateway address(es) and 2 runtime address(es)');
  });

  it('says why the autoscaler is off', async () => {
    renderWithProviders(
      <EngineFleet load={async () => ({ ...DATA, autoscale: { ...DATA.autoscale!, refusal: 'AUTOSCALE_ENABLED is not set' } })} />,
    );
    expect(await screen.findByTestId('fleet-autoscale-off')).toHaveTextContent('AUTOSCALE_ENABLED is not set');
  });
});
