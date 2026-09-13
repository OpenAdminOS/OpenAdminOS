import assert from 'node:assert/strict';
import { it } from 'node:test';
import { novaCommand, parseNovaCommand } from '../src/shared/nova-command.js';
import { novaStopCommand, isNovaConversationOnly } from '../src/shared/nova-transcript.js';

const connectors = ['Outlook','Exchange','email','WhatsApp','Teams','Slack','Discord','Signal'];
for (const channel of connectors) {
  for (const prefix of ['', 'Please ', 'Alright, so can you ', 'Hey Nova, could you ']) {
    it(`routes conversational delivery: ${prefix}${channel}`, () => {
      assert.equal(novaCommand(`${prefix}send the list of non-compliant devices via ${channel}, please.`)?.kind, 'send');
    });
  }
}
for (const [text, expected] of [
  ['Could you take me to the Agent Team page?', 'navigate'],
  ['Okay, please bring up Connectors', 'navigate'],
  ['Open settings, please', 'navigate'],
  ['Will you go to cache?', 'navigate'],
  ['What agents are installed?', 'capabilities'],
  ['Hey, are you connected to any tenant?', 'capabilities'],
  ['Why is Outlook not sending?', 'capabilities'],
  ['Email is connected', 'capabilities'],
  ['Is Microsoft Teams connected?', 'capabilities'],
  ["Outlook is connected, why can’t you send?", 'capabilities'],
  ['How many devices do I have?', 'research'],
  ['Do you see any of my devices?', 'research'],
  ['Show me the latest macOS version', 'research'],
  ['Compare the installed Windows versions with the latest releases', 'research'],
  ['Send this via Teams and Slack', 'clarify'],
  ['Can you send me an email with the list and post it to Teams?', 'clarify'],
  ['Email this and then run the auditor', 'clarify'],
  ['Send this via Teams tomorrow', 'clarify'],
  ['Send this to Alice via Outlook', 'clarify'],
  ['Send this to alice@example.test', 'clarify'],
  ['Email me the report but exclude Windows', 'clarify'],
  ["Don't email me the report", 'research'],
  ['If I say send this via Teams, what happens?', 'research'],
  ['“Send this via WhatsApp” is in the report', 'research'],
  ['Yes please', 'clarify'],
  ['Go ahead', 'clarify'],
  ['Do it', 'clarify'],
] as const) it(`routes or clarifies: ${text}`, () => assert.equal(novaCommand(text)?.kind, expected));

it('defers unfamiliar wording instead of sending it into general research', () => {
  for (const text of ['Pop that report into my inbox', 'Get the auditor going', 'Actually use Teams instead', 'Outlook', 'Could you forward those findings to my WhatsApp?', 'What is preventing you from messaging me through Outlook?', 'Email Alice the list', 'Send Alice the report via Teams']) assert.equal(novaCommand(text), undefined, text);
});
it('rejects malformed or invented classifier actions', () => {
  const context = { agents: [{ name: 'Auditor', slug: 'auditor' }] };
  for (const raw of ['null','[]','not JSON', '{"kind":"execute"}', '{"kind":"navigate","page":"https://example.test"}', '{"kind":"run","name":"missing"}', '{"kind":"send","connectorId":"outlook","self":false,"to":"alice"}', '{"kind":"send","connectorId":"outlook","self":"false"}', '{"kind":"send","connectorId":"outlook","self":false,"question":""}', '{"kind":"research","send":true}', '{"kind":"send","connectorId":"telegram","self":false}']) assert.deepEqual(parseNovaCommand(raw, context), { kind: 'clarify', reason: 'unavailable' }, raw);
  assert.deepEqual(parseNovaCommand('{"kind":"run","name":"auditor"}',context), { kind: 'run', name: 'auditor' });
  assert.deepEqual(parseNovaCommand('{"kind":"send","connectorId":"outlook","self":true,"question":null}',context), { kind: 'send', connectorId: 'outlook', self: true });
});
it('understands stop variants and preserves the next question', () => {
  for (const text of ['Never mind', 'Okay, cancel that email', 'Hey Nova, stop sending', 'Cancel this email', 'Stop now', 'No thanks', "Don't send it", 'Please cancel the action']) assert.equal(novaStopCommand(text), '', text);
  assert.equal(novaStopCommand('Stop and tell me how many devices there are'), 'tell me how many devices there are');
  for (const text of ['Do not stop', 'What does stop mean?', 'If I say stop', 'The report says stop']) assert.equal(novaStopCommand(text), undefined, text);
  for (const text of ['Okay, are you still working?', 'Hey Nova, tell me a joke while we wait', 'Alright, thanks', 'Hey Nova', 'Okay', 'How are you doing?', 'Good morning Nova', 'Thanks Nova', 'Are you done yet?']) assert.equal(isNovaConversationOnly(text), true, text);
});
