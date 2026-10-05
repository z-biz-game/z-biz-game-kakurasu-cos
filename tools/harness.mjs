// Tiny zero-dep test harness: every tools/../test/*.mjs suite prints the same shape so
// verify.sh can aggregate them.

const rows = [];

export function test(name, fn) {
  try {
    fn();
    rows.push({ test: name, pass: true });
  } catch (err) {
    rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
  }
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

// test() 同步调用 body，所以 async 行不能直接交给它：抛出的断言会变成一条没人 await 的
// promise，行还是绿的。atest 先 await 出结果，再把结果按同样形状登记进 rows。
export async function atest(name, fn) {
  try {
    await fn();
    test(name, () => {});
  } catch (err) {
    test(name, () => { throw err; });
  }
}

export function run() {
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  console.log(`rows: ${rows.length} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}
