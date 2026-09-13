import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { NovaConversation } from './NovaConversation';

const report = `## Device report

**2 devices** need review. _Snapshot only._

- **Device A**
  - Encryption: unknown
- Device B

3. Check compliance
4. Review settings

| Device | State |
| --- | --- |
| Device A | **Non-compliant** |
| Device B | Unknown |

> Verify policy settings before remediation.

Use \`Get-Device\` and [documentation](https://example.test/docs).

\`\`\`powershell
Get-Device -All
\`\`\`

<script>alert('unsafe')</script>
[unsafe](javascript:alert(1))`;

it('renders formatting in speech bubbles and retrieved evidence without executing HTML', async () => {
  const { container } = render(<NovaConversation onClose={() => {}} items={[
    { id: 'speech', kind: 'speech', role: 'assistant', text: report },
    { id: 'evidence', kind: 'activity', status: 'completed', steps: [], result: report },
  ]} />);
  const bubble = container.querySelector('.nova-message-body')!;
  expect(bubble.querySelector('strong')).toHaveTextContent('2 devices');
  expect(bubble.querySelector('ul ul li')).toHaveTextContent('Encryption: unknown');
  expect(bubble.querySelector('ol')).toHaveAttribute('start', '3');
  expect(bubble.querySelector('table th')).toHaveTextContent('Device');
  expect(bubble.querySelector('blockquote')).toHaveTextContent('Verify policy settings');
  expect(bubble.querySelector('pre code')).toHaveTextContent('Get-Device -All');
  expect(bubble.querySelector('a')).toHaveAttribute('href', 'https://example.test/docs');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  await userEvent.click(screen.getByText('View result'));
  expect(within(container.querySelector('.nova-activity-result') as HTMLElement).getByRole('table')).toBeVisible();
});

it('settles incomplete streamed formatting and renders a single numbered item as a list', () => {
  const { rerender, container } = render(<NovaConversation onClose={() => {}} items={[{ id: 'speech', kind: 'speech', role: 'assistant', text: '**Two' }]} />);
  expect(container).toHaveTextContent('**Two');
  rerender(<NovaConversation onClose={() => {}} items={[{ id: 'speech', kind: 'speech', role: 'assistant', text: '**Two devices**\n\n1. Review them' }]} />);
  expect(container.querySelector('strong')).toHaveTextContent('Two devices');
  expect(container.querySelector('ol li')).toHaveTextContent('Review them');
});
