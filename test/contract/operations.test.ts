// Contract tests: every operation, sent through the wrapper, against a Prism
// mock of the committed openapi.json. Prism runs with --errors, so a request
// that doesn't match the spec (path, query, headers, body, auth) is refused
// and the call throws. Started by scripts/contract.mjs.
import { describe, expect, it } from "vitest";
import { Sinatra, SinatraError } from "../../src/index";

const baseUrl = process.env.SINATRA_CONTRACT_URL;
if (!baseUrl) throw new Error("SINATRA_CONTRACT_URL is not set: run `npm run test:contract`");

const sinatra = new Sinatra({ token: "sntr_contract", baseUrl });
const WS = "ws_contract";
const TASK = "task_contract";

describe("every operation matches the spec", () => {
  it("me.get", async () => {
    const me = await sinatra.me.get();
    expect(typeof me.user.id).toBe("string");
    expect(Array.isArray(me.workspaces)).toBe(true);
  });

  it("me.revokeToken", async () => {
    await expect(sinatra.me.revokeToken()).resolves.toBeUndefined();
  });

  it("tasks.list", async () => {
    const page = await sinatra.tasks.list(WS, { status: "pr_open", limit: 100, cursor: "opaque" });
    expect(Array.isArray(page.tasks)).toBe(true);
  });

  it("tasks.create", async () => {
    const created = await sinatra.tasks.create(WS, { prompt: "Fix the flaky test", title: "Flaky", repo: "acme/web" });
    expect(typeof created.task.id).toBe("string");
    expect(typeof created.messageId).toBe("string");
  });

  it("tasks.create with your own key", async () => {
    await sinatra.tasks.create(WS, { prompt: "Fix it" }, { idempotencyKey: "ci-run-42:fix-it" });
  });

  it("tasks.get", async () => {
    const task = await sinatra.tasks.get(WS, TASK);
    expect(typeof task.status).toBe("string");
  });

  it("tasks.stop", async () => {
    expect(await sinatra.tasks.stop(WS, TASK)).toEqual({ accepted: true });
  });

  it("messages.create", async () => {
    const sent = await sinatra.messages.create(WS, TASK, { text: "Also update the docs" });
    expect(typeof sent.messageId).toBe("string");
  });

  it("messages.list", async () => {
    const page = await sinatra.messages.list(WS, TASK, { after: "entry_1", limit: 200 });
    expect(Array.isArray(page.messages)).toBe(true);
  });

  it("tickets.search", async () => {
    const found = await sinatra.tickets.search(WS, { q: "flaky", repo: "acme/web" });
    expect(Array.isArray(found.tickets)).toBe(true);
  });

  it("tickets.delegate (linear)", async () => {
    expect(await sinatra.tickets.delegate(WS, { source: "linear", id: "ENG-123" })).toEqual({ ok: true });
  });

  it("tickets.delegate (github)", async () => {
    expect(await sinatra.tickets.delegate(WS, { source: "github", repo: "acme/web", number: 7 })).toEqual({ ok: true });
  });
});

describe("the mock refuses what the spec forbids", () => {
  // Guards the suite itself: if Prism stopped validating requests, every
  // test above would pass vacuously.
  it("a prompt that breaks the schema is refused", async () => {
    const err = await sinatra.tasks.create(WS, { prompt: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SinatraError);
    expect((err as SinatraError).status).toBeGreaterThanOrEqual(400);
  });

  it("a request without a token is refused", async () => {
    const anonymous = new Sinatra({
      token: "unused",
      baseUrl,
      fetch: (input, init) => {
        const request = new Request(input, init);
        request.headers.delete("authorization");
        return fetch(request);
      },
    });
    const err = await anonymous.me.get().catch((e: unknown) => e);
    expect((err as SinatraError).status).toBe(401);
  });
});
