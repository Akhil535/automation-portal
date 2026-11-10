// Microsoft Word on this PC is ONE shared program (Microsoft 365 hands every caller the same running Word): two
// conversions at once would share – and close – each other's Word ("The RPC server is unavailable"). Every use of
// Word by the portal (PDF conversion, .doc → .docx) waits its turn here.
let tail = Promise.resolve();
let waiting = 0;
/** Run fn (returning a promise) when Word is free; the queue moves on whether it succeeds or fails. */
export function withWord(fn) {
  waiting++;
  const run = tail.then(() => fn()).finally(() => { waiting--; });
  tail = run.catch(() => {});
  return run;
}
/** How many Word jobs are running or waiting (for progress messages). */
export const wordBusy = () => waiting;
