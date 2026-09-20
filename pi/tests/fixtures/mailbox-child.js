// Test fixture: a delegated child that speaks the AgentTask marker protocol.
// - emits a child→parent post + a shared-stream event as stdout markers
// - echoes any stdin line as GOT:<line> so the test can prove the parent→
//   child steer frame actually arrived
// - stays alive ~1.5s so the bridge's inbox poller has time to forward
console.log(`PAI_TASK_POST ${JSON.stringify({ body: 'child partial result' })}`);
console.log(`PAI_TASK_EVENT ${JSON.stringify({ kind: 'progress', pct: 50 })}`);
process.stdin.on('data', (d) => {
  for (const line of d.toString().split('\n').filter(Boolean)) console.log(`GOT:${line}`);
});
setTimeout(() => {
  console.log(`PAI_TASK_POST ${JSON.stringify({ body: 'child final result' })}`);
  setTimeout(() => process.exit(0), 50);
}, 1400);
