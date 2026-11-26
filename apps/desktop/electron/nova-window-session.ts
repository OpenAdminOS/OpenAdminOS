/** Keep microphone ownership until the previous renderer acknowledges cleanup. */
export class NovaWindowSession {
  owner?: number;
  private handoff?: { target: number; release: () => void };

  async claim(id: number, requestStop: (owner: number) => void): Promise<void> {
    if (this.owner === id) return;
    if (this.handoff) throw new Error("Nova is switching windows. Try again.");
    if (this.owner !== undefined) {
      const handoff = { target: id, release: () => {} };
      this.handoff = handoff;
      const stopped = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 2000);
        handoff.release = () => { clearTimeout(timer); resolve(true); };
        requestStop(this.owner!);
      });
      this.handoff = undefined;
      if (!stopped || handoff.target !== id) throw new Error("Nova could not switch windows. Start it again to retry.");
    }
    this.owner = id;
  }

  release(id: number, stop: () => void): void {
    if (this.handoff?.target === id) this.handoff.target = -1;
    if (this.owner !== id) return;
    stop();
    this.owner = undefined;
    this.handoff?.release();
  }
}
