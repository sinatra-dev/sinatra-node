import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sinatra, SinatraError } from "../src/index";
import { startStub, type Stub } from "./stub-server";

const WS = "ws_1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task_1",
    status: "implementing",
    source: "api",
    title: "Fix the flaky test",
    repo: "acme/web",
    pullRequest: null,
    queued: false,
    createdAt: "2026-10-16T12:00:00.000Z",
    lastActivityAt: null,
    url: "https://app.sinatra.dev/tasks/task_1",
    ...overrides,
  };
}

function message(id: string) {
  return {
    id,
    messageId: null,
    role: "agent",
    kind: "response",
    body: `entry ${id}`,
    createdAt: "2026-10-16T12:00:00.000Z",
  };
}

const ME = { user: { id: "user_1", githubLogin: "octo", name: "Octo" }, workspaces: [] };

/** Lets real I/O (the stub's sockets) make progress while fake timers are installed. */
async function flushIo(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Advances the fake clock in small steps, letting real I/O run between steps,
 * until `done()` holds. Returns how much fake time passed.
 */
async function advanceUntil(done: () => boolean, stepMs = 50, limitMs = 120_000): Promise<number> {
  let elapsed = 0;
  await flushIo();
  while (!done()) {
    if (elapsed >= limitMs) throw new Error(`condition not met after ${limitMs}ms of fake time`);
    await vi.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
    await flushIo();
  }
  return elapsed;
}

let stub: Stub;
let sinatra: Sinatra;

beforeEach(async () => {
  stub = await startStub();
  sinatra = new Sinatra({ token: "sntr_test", baseUrl: stub.url });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await stub.close();
});

describe("retries", () => {
  it("retries reuse the idempotency key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stub.reply(
      { status: 503, body: { error: "unavailable", taskId: "task_1", messageId: "m" } },
      { status: 202, body: { task: task(), messageId: "m" } },
    );

    const result = sinatra.tasks.create(WS, { prompt: "Fix the flaky test" });
    await advanceUntil(() => stub.requests.length === 2);
    const created = await result;

    expect(created.task.id).toBe("task_1");
    const keys = stub.requests.map((r) => r.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toBe(keys[0]);
  });

  it("a key you pass is sent on every attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stub.reply({ status: 503, body: { error: "unavailable" } }, { status: 202, body: { messageId: "mine-1" } });

    const result = sinatra.messages.create(WS, "task_1", { text: "and the docs" }, { idempotencyKey: "mine-1" });
    await advanceUntil(() => stub.requests.length === 2);
    await result;

    expect(stub.requests.map((r) => r.headers["idempotency-key"])).toEqual(["mine-1", "mine-1"]);
  });

  it("each call gets its own key", async () => {
    stub.reply({ status: 202, body: { messageId: "a" } }, { status: 202, body: { messageId: "b" } });

    await sinatra.messages.create(WS, "task_1", { text: "one" });
    await sinatra.messages.create(WS, "task_1", { text: "two" });

    const [first, second] = stub.requests.map((r) => r.headers["idempotency-key"]);
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it("429 honours Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stub.reply(
      { status: 429, headers: { "retry-after": "1" }, body: { error: "rate_limited" } },
      { status: 200, body: ME },
    );

    const result = sinatra.me.get();
    await advanceUntil(() => stub.requests.length === 1);
    const waited = await advanceUntil(() => stub.requests.length === 2);
    await expect(result).resolves.toEqual(ME);

    expect(waited).toBeGreaterThanOrEqual(1000);
    expect(waited).toBeLessThan(1500);
  });

  it("Retry-After is capped at 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stub.reply(
      { status: 429, headers: { "retry-after": "3600" }, body: { error: "rate_limited" } },
      { status: 200, body: ME },
    );

    const result = sinatra.me.get();
    await advanceUntil(() => stub.requests.length === 1);
    const waited = await advanceUntil(() => stub.requests.length === 2, 1000);
    await result;

    expect(waited).toBeGreaterThanOrEqual(60_000);
    expect(waited).toBeLessThanOrEqual(61_000);
  });

  it("503 backs off 0.5s, 1s, 2s and gives up after 3 retries", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let i = 0; i < 4; i++) stub.reply({ status: 503, body: { error: "unavailable" } });

    const result = sinatra.tasks.get(WS, "task_1");
    const settled = result.catch((err: unknown) => err);
    await advanceUntil(() => stub.requests.length === 1);
    const gaps: number[] = [];
    for (const n of [2, 3, 4]) gaps.push(await advanceUntil(() => stub.requests.length === n, 25));
    const err = await settled;

    expect(err).toBeInstanceOf(SinatraError);
    expect((err as SinatraError).status).toBe(503);
    expect(stub.requests).toHaveLength(4);
    expect(gaps[0]).toBeGreaterThanOrEqual(500);
    expect(gaps[0]).toBeLessThan(1000);
    expect(gaps[1]).toBeGreaterThanOrEqual(1000);
    expect(gaps[1]).toBeLessThan(2000);
    expect(gaps[2]).toBeGreaterThanOrEqual(2000);
    expect(gaps[2]).toBeLessThan(4000);
  });

  it("500 is not retried", async () => {
    stub.reply({ status: 500, body: { error: "internal_error", reason: "boom" } });

    const err = await sinatra.tasks.stop(WS, "task_1").catch((e: unknown) => e);

    expect(stub.requests).toHaveLength(1);
    expect(err).toBeInstanceOf(SinatraError);
    expect((err as SinatraError).status).toBe(500);
  });

  it("tasks.stop retries 503 but not 429", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stub.reply({ status: 503, body: { error: "unavailable" } }, { status: 202, body: { accepted: true } });

    const stopped = sinatra.tasks.stop(WS, "task_1");
    await advanceUntil(() => stub.requests.length === 2);
    await expect(stopped).resolves.toEqual({ accepted: true });

    vi.useRealTimers();
    stub.reply({ status: 429, headers: { "retry-after": "0" }, body: { error: "rate_limited" } });
    const err = await sinatra.tasks.stop(WS, "task_1").catch((e: unknown) => e);
    expect((err as SinatraError).status).toBe(429);
    expect(stub.requests).toHaveLength(3);
  });

  it("a POST without an idempotency key is not retried", async () => {
    stub.reply({ status: 503, body: { error: "unavailable" } });

    const err = await sinatra.tickets.delegate(WS, { source: "linear", id: "ENG-1" }).catch((e: unknown) => e);

    expect((err as SinatraError).status).toBe(503);
    expect(stub.requests).toHaveLength(1);
  });
});

describe("decoding", () => {
  it("unknown status decodes", async () => {
    stub.reply({ status: 200, body: task({ status: "teleporting", source: "carrier_pigeon", brandNewField: 1 }) });

    const got = await sinatra.tasks.get(WS, "task_1");

    expect(got.status).toBe("teleporting");
    expect(got.source).toBe("carrier_pigeon");
  });

  it("unknown error code surfaces", async () => {
    stub.reply({ status: 409, headers: { "x-request-id": "req_9" }, body: { error: "brand_new", reason: "x" } });

    const err = await sinatra.messages.create(WS, "task_1", { text: "hi" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SinatraError);
    const e = err as SinatraError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("brand_new");
    expect(e.reason).toBe("x");
    expect(e.requestId).toBe("req_9");
    expect(e.body).toEqual({ error: "brand_new", reason: "x" });
    expect(stub.requests).toHaveLength(1);
  });

  it("an error without a JSON body still surfaces its status", async () => {
    stub.reply({ status: 502, headers: { "content-type": "text/html" }, body: "<html>bad gateway</html>" });

    const err = await sinatra.tasks.get(WS, "task_1").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SinatraError);
    expect((err as SinatraError).status).toBe(502);
    expect((err as SinatraError).body).toBe("<html>bad gateway</html>");
  });
});

describe("requests", () => {
  it("bodyless requests send no content-type", async () => {
    stub.reply({ status: 202, body: { accepted: true } }, { status: 204 }, { status: 200, body: task() });

    await sinatra.tasks.stop(WS, "task_1");
    await expect(sinatra.me.revokeToken()).resolves.toBeUndefined();
    await sinatra.tasks.get(WS, "task_1");

    expect(stub.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /v1/workspaces/ws_1/tasks/task_1/stop",
      "DELETE /v1/me/token",
      "GET /v1/workspaces/ws_1/tasks/task_1",
    ]);
    for (const r of stub.requests) {
      expect(r.headers["content-type"]).toBeUndefined();
      expect(r.body).toBe("");
    }
  });

  it("requests with a body send JSON", async () => {
    stub.reply({ status: 202, body: { task: task(), messageId: "m" } });

    await sinatra.tasks.create(WS, { prompt: "Fix it", repo: "acme/web" });

    expect(stub.requests[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(stub.requests[0]?.body ?? "")).toEqual({ prompt: "Fix it", repo: "acme/web" });
  });

  it("the token defaults to SINATRA_TOKEN", async () => {
    vi.stubEnv("SINATRA_TOKEN", "sntr_from_env");
    stub.reply({ status: 200, body: ME });

    await new Sinatra({ baseUrl: stub.url }).me.get();

    expect(stub.requests[0]?.headers.authorization).toBe("Bearer sntr_from_env");
  });

  it("no token is an error before any request", () => {
    vi.stubEnv("SINATRA_TOKEN", "");

    expect(() => new Sinatra({ baseUrl: stub.url })).toThrow(/SINATRA_TOKEN/);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("timeouts", () => {
  it("a hung request is aborted", async () => {
    stub.reply({ status: 0, hang: true }, { status: 0, hang: true });

    const timedOut = await new Sinatra({ token: "sntr_test", baseUrl: stub.url, timeout: 50 }).tasks
      .get(WS, "task_1")
      .catch((e: unknown) => e);
    expect((timedOut as Error).name).toBe("TimeoutError");

    const controller = new AbortController();
    const cancelled = sinatra.tasks.get(WS, "task_1", { signal: controller.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(stub.requests).toHaveLength(2));
    controller.abort(new Error("caller gave up"));
    expect(((await cancelled) as Error).message).toBe("caller gave up");

    expect(stub.requests).toHaveLength(2);
  });
});

describe("pagination", () => {
  it("list iterator follows nextCursor", async () => {
    stub.reply(
      { status: 200, body: { tasks: [task({ id: "t1" }), task({ id: "t2" })], nextCursor: "c2" } },
      { status: 200, body: { tasks: [task({ id: "t3" })], nextCursor: null } },
    );

    const ids: string[] = [];
    for await (const t of sinatra.tasks.listAll(WS, { status: "pr_open", limit: 2 })) ids.push(t.id);

    expect(ids).toEqual(["t1", "t2", "t3"]);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]?.url.searchParams.get("cursor")).toBeNull();
    expect(stub.requests[1]?.url.searchParams.get("cursor")).toBe("c2");
    for (const r of stub.requests) {
      expect(r.url.searchParams.get("status")).toBe("pr_open");
      expect(r.url.searchParams.get("limit")).toBe("2");
    }
  });

  it("message iterator follows next as after", async () => {
    stub.reply(
      { status: 200, body: { messages: [message("e1")], next: "e1" } },
      { status: 200, body: { messages: [message("e2")], next: null } },
    );

    const ids: string[] = [];
    for await (const m of sinatra.messages.listAll(WS, "task_1")) ids.push(m.id);

    expect(ids).toEqual(["e1", "e2"]);
    expect(stub.requests[0]?.url.searchParams.get("after")).toBeNull();
    expect(stub.requests[1]?.url.searchParams.get("after")).toBe("e1");
  });
});
