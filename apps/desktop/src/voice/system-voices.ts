export function systemVoices(synthesis: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const voices = synthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      synthesis.removeEventListener("voiceschanged", finish);
      resolve(synthesis.getVoices());
    };
    const timer = setTimeout(finish, 1500);
    synthesis.addEventListener("voiceschanged", finish, { once: true });
    if (synthesis.getVoices().length) finish();
  });
}
