// Test fixture: a delegated worker that does work and reports its own
// token/cost usage the way a real delegate agent would.
console.log('worker output from fixture');
console.log(`PAI_USAGE ${JSON.stringify({ input: 1200, output: 80, cost: 0.0042 })}`);
