// Manual verification: default Codex CLI, or NOVA_VERIFY_PROVIDER=ollama NOVA_VERIFY_MODEL=qwen3:8b. Synthetic commands only.
// No Graph requests, connector sends, or agent runs are executed.
import { createOllamaLlm } from '../packages/runtime/src/llm-ollama.ts';
import { createCodexLlm } from '../packages/runtime/src/llm-codex.ts';
import { novaContextualCommand, novaCommandInstructions, parseNovaCommand } from '../apps/desktop/src/shared/nova-command.ts';
const cases = [
 ['Pop that report into my inbox', 'send', undefined, 'outlook'],
 ['Could you forward those findings to my WhatsApp?', 'send', undefined, 'whatsapp-web'],
 ['Get the inactive device auditor going', 'run'],
 ['Actually use Teams instead', 'send', JSON.stringify({kind:'send',connectorId:'outlook',self:false}), 'teams'],
 ['Outlook', 'send', 'Please send the list of non-compliant devices'],
 ['What is preventing you from messaging me through Outlook?', 'capabilities'],
 ['Would you mind taking me to the office?', 'navigate'],
 ['I need this delivered to Alice', 'clarify'],
 ['Create a schedule to email this every morning', 'clarify'],
 ['Could you disable all those devices?', 'clarify'],
 ['I wonder whether the cached results are still current', 'research'],
 ['How do I send an email from Outlook?', 'capabilities'],
 ['Send me a Teams message with all the non-compliant devices as a list', 'send', undefined, 'teams'],
 ['Send this via Teams to the General channel', 'send', undefined, 'teams'],
 ['Can you send it also via WhatsApp', 'send', undefined, 'whatsapp-web'],
 ['Can you also send it- send it with Outlook', 'send', undefined, 'outlook'],
 ['What I want you to do is send me a list of non-compliant devices via email with the Outlook connector', 'send', undefined, 'outlook'],
 ['email Outlook email', 'send', JSON.stringify({kind:'send',connectorId:'outlook',self:true}), 'outlook'],
 ['Inactive device auditor', 'run'],
] as const;
async function main() {
 const llm = process.env.NOVA_VERIFY_PROVIDER === 'ollama' ? createOllamaLlm({defaultModel:process.env.NOVA_VERIFY_MODEL || 'qwen3:8b'}) : createCodexLlm();
 let failed=0;
 for (const [text, kind, previousRequest, connectorId] of cases) {
  const context = {agents:[{name:'Inactive device auditor',slug:'inactive-device-auditor'}], ...(previousRequest ? {previousRequest} : {})};
  const start=Date.now();
  try {
   const direct = novaContextualCommand(text, context);
   const result = direct ?? parseNovaCommand((await llm.complete({system:novaCommandInstructions,prompt:JSON.stringify({currentRequest:text,...context}),maxTokens:400,temperature:0,signal:AbortSignal.timeout(15000)})).text,context);
   const referenceOk = text !== 'Could you forward those findings to my WhatsApp?' || (result.kind === 'send' && !result.question);
   const ok=referenceOk && result.kind===kind && (!connectorId || (result.kind==='send' && result.connectorId===connectorId));
   if(!ok)failed++;
   console.log(JSON.stringify({text,ok,result,durationMs:Date.now()-start}));
  } catch(e) {failed++;console.log(JSON.stringify({text,ok:false,error:e instanceof Error?e.message:'failed',durationMs:Date.now()-start}));}
 }
 console.log(JSON.stringify({cases:cases.length,failed}));process.exitCode=failed?1:0;
}
void main();
