// Runs the contract tests: starts `prism mock openapi.json --errors` on a free
// port, waits for it, runs the vitest "contract" project against it, stops it.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = (name) => fileURLToPath(new URL(`../node_modules/.bin/${name}`, import.meta.url));

const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const url = `http://127.0.0.1:${port}`;

const prism = spawn(bin("prism"), ["mock", "openapi.json", "--errors", "-h", "127.0.0.1", "-p", String(port), "-v", "warn"], {
  cwd: root,
  stdio: ["ignore", "inherit", "inherit"],
});
let prismExit = null;
prism.on("exit", (code, signal) => {
  prismExit = code ?? signal;
});

async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (prismExit !== null) throw new Error(`prism exited early (${prismExit})`);
    try {
      await fetch(`${url}/v1/me`, { headers: { authorization: "Bearer probe" } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("prism did not start within 60s");
}

let code = 1;
try {
  await ready();
  code = await new Promise((resolve) => {
    const vitest = spawn(bin("vitest"), ["run", "--project", "contract"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, SINATRA_CONTRACT_URL: url },
    });
    vitest.on("exit", (c) => resolve(c ?? 1));
  });
} catch (err) {
  console.error(err);
} finally {
  prism.kill();
}
process.exit(code);
