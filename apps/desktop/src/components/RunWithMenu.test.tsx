import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RunWithMenu } from './RunWithMenu';
import type { ProviderSummary } from '../shared/openAdminOS';

it('Escape closes per-run model choices and returns focus without starting a run', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  render(<RunWithMenu providers={[{ id: 'ollama', name: 'Ollama', isLocal: true, status: 'connected', models: ['one', 'two'] } as ProviderSummary]} activeProviderId="ollama" onRun={onRun} />);
  const trigger = screen.getByRole('button', { name: 'Choose provider or model for this run' });
  await user.click(trigger);
  expect(screen.getByRole('menu')).toBeInTheDocument();
  screen.getByRole('button', { name: 'two' }).focus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  expect(onRun).not.toHaveBeenCalled();
});

it('names Copilot Fusion tiers, says who sees the prompt, and never runs a tier the plan lacks', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const copilot = {
    id: 'copilot', name: 'GitHub Copilot CLI', description: '', isLocal: false, status: 'connected', models: ['fusion-standard', 'fusion-high'],
    modelLabels: { 'fusion-high': 'Copilot Fusion High', 'fusion-max': 'Copilot Fusion Max' },
    unavailableModels: [{ id: 'fusion-max', reason: 'Not included in your Copilot plan.' }],
  } as ProviderSummary;
  render(<RunWithMenu providers={[copilot]} activeProviderId="copilot" onRun={onRun} />);
  await user.click(screen.getByRole('button', { name: 'Choose provider or model for this run' }));
  expect(screen.getByRole('button', { name: /Copilot Fusion High/ })).toHaveTextContent('Several models may see each prompt');
  const max = screen.getByRole('button', { name: /Copilot Fusion Max/ });
  expect(max).toHaveAttribute('aria-disabled', 'true');
  expect(max).toHaveTextContent('Not included in your Copilot plan.');
  await user.click(max);
  expect(onRun).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: /Copilot Fusion High/ }));
  expect(onRun).toHaveBeenCalledWith({ providerId: 'copilot', model: 'fusion-high' });
});

it('lists every Copilot Fusion tier with its reason when the plan includes none of them', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const copilot = {
    id: 'copilot', name: 'GitHub Copilot CLI', description: '', isLocal: false, status: 'error', models: [],
    modelLabels: { 'fusion-standard': 'Copilot Fusion Standard' },
    unavailableModels: [{ id: 'fusion-standard', reason: "Turned off by your organization's policy." }],
  } as ProviderSummary;
  render(<RunWithMenu providers={[{ id: 'ollama', name: 'Ollama', description: '', isLocal: true, status: 'connected', models: ['one'] } as ProviderSummary, copilot]} activeProviderId="ollama" onRun={onRun} />);
  await user.click(screen.getByRole('button', { name: 'Choose provider or model for this run' }));
  const standard = screen.getByRole('button', { name: /Copilot Fusion Standard/ });
  expect(standard).toHaveAttribute('aria-disabled', 'true');
  expect(standard).toHaveTextContent("Turned off by your organization's policy.");
  expect(screen.queryByText('No models installed')).not.toBeInTheDocument();
  await user.click(standard);
  expect(onRun).not.toHaveBeenCalled();
});
