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
