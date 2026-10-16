// Loads the built package through both entry points (ESM and CJS) and makes
// real requests against a local server: a start that hits a 503 and is retried
// with the same Idempotency-Key, and a bodyless stop. Run after `npm run build`,
// on every Node version the package supports (engines: >=20).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";

const esm = await import("../dist/index.js");
const cjs = createRequire(import.meta.url)("../dist/index.cjs");

const replies = [];
const seen = [];
const server = createServer((req, res) => {
  seen.push({ method: req.method, url: req.url, headers: req.headers });
  req.resume();
  req.on("end", () => {
    const [status, body] = replies.shift() ?? [599, { error: "smoke_exhausted" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [name, mod] of [["esm", esm], ["cjs", cjs]]) {
    seen.length = 0;
    const sinatra = new mod.Sinatra({ token: "sntr_smoke", baseUrl });
    replies.push([503, { error: "unavailable" }], [202, { task: { id: "t1" }, messageId: "m1" }], [202, { accepted: true }]);

    const created = await sinatra.tasks.create("ws", { prompt: "smoke" });
    assert.equal(created.task.id, "t1");
    assert.equal(seen.length, 2);
    assert.match(seen[0].headers["idempotency-key"], /^[0-9a-f-]{36}$/);
    assert.equal(seen[1].headers["idempotency-key"], seen[0].headers["idempotency-key"]);
    assert.equal(seen[0].headers.authorization, "Bearer sntr_smoke");

    await sinatra.tasks.stop("ws", "t1");
    assert.equal(seen[2].headers["content-type"], undefined);

    const err = await sinatra.tasks.get("ws", "t1").catch((e) => e);
    assert.ok(err instanceof mod.SinatraError, `${name}: expected SinatraError`);
    assert.equal(err.status, 599);
    console.log(`smoke ${name} ok on node ${process.version}`);
  }
} finally {
  server.close();
}
