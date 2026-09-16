/**
 * M7 drill fixture — runs ONE host "life" in a child process so the parent
 * test can kill it at the OS level (SIGKILL / TerminateProcess), then prove
 * continuity by cold-starting a second life over the same instance root.
 *
 * Usage: node pi/tests/fixtures/m7-life1.js <instanceRoot>
 * Prints `READY <runId> <predictionId> <jobId>` once the life-1 state is
 * durably written (audit appends are synchronous), then stays alive until
 * killed.
 */
import { startHost } from '../../src/bootstrap/host.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node m7-life1.js <instanceRoot>');
  process.exit(2);
}

const stubModel = {
  id: 'stub', name: 'stub', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096,
};

const host = await startHost({ instanceRoot: dir, workdir: dir, sessionOptions: { model: stubModel } });
const p = host.predictions.open({ claim: 'rain tomorrow', horizon: '1d' });
const job = host.jobStore.createJob({ jobType: 'shell_command', authorizedRoot: dir });
host.jobStore.startAttempt({
  jobId: job.job_id, writerId: 'life1', workerType: 'child_process',
  workerIdentity: { pid: 999_999_999 }, // dead-on-arrival pid: worker already gone
});
console.log(`READY ${host.runId} ${p.id} ${job.job_id}`);
setInterval(() => {}, 60_000); // stay alive until the parent kills us
