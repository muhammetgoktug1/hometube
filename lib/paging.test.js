import assert from "node:assert/strict";

// The paging notice: with HOMETUBE_PAGING=1 every new connection hears `paging:on`; without it nothing listens.
const fakeIo = () => {
  const io = { handlers: 0, sent: [] };
  io.on = (name, fn) => {
    assert.equal(name, "connection");
    io.handlers += 1;
    fn({ emit: (...args) => io.sent.push(args) });
  };
  return io;
};

const load = async (flag, tag) => {
  if (flag === undefined) delete process.env.HOMETUBE_PAGING;
  else process.env.HOMETUBE_PAGING = flag;
  return import(`./paging.js?${tag}`);
};

const checks = {
  "off: no listener, nothing sent": async () => {
    for (const [flag, tag] of [[undefined, "unset"], ["0", "zero"], ["", "empty"], ["true", "word"]]) {
      const io = fakeIo();
      (await load(flag, tag)).startPaging(io);
      assert.deepEqual([io.handlers, io.sent], [0, []], String(flag));
    }
  },
  "on: every connection hears paging:on, and only that": async () => {
    const io = fakeIo();
    (await load("1", "on")).startPaging(io);
    assert.deepEqual([io.handlers, io.sent], [1, [["paging:on"]]]);
  },
};

const failed = [];
for (const [name, check] of Object.entries(checks)) {
  try {
    await check();
  } catch (err) {
    failed.push(name);
    console.error(`FAIL ${name}: ${err.name}: ${String(err.message).split("\n")[0]}`);
  }
}
if (failed.length) {
  console.error(`paging: ${failed.length} of ${Object.keys(checks).length} checks failed`);
  process.exit(1);
}
console.log(`paging ok (${Object.keys(checks).length} checks)`);
