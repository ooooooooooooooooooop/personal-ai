// Test fixture standing in for a real pai-channel child body: it must see
// the PAI_BUDGET_MAX_* env the delegate-bridge injected, then report usage.
console.log(`CHILD_ENV ${JSON.stringify({
  PAI_BUDGET_MAX_TOKENS: process.env.PAI_BUDGET_MAX_TOKENS ?? null,
  PAI_BUDGET_MAX_CALLS: process.env.PAI_BUDGET_MAX_CALLS ?? null,
  PAI_BUDGET_MAX_COST_USD: process.env.PAI_BUDGET_MAX_COST_USD ?? null,
})}`);
console.log(`PAI_USAGE ${JSON.stringify({ input: 100, output: 20 })}`);
