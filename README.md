# Sinatra Node.js / TypeScript SDK

`@sinatra-dev/sdk` is the official TypeScript client for [sinatra.dev](https://www.sinatra.dev), the hosted AI coding agent that turns Linear and GitHub issues into pull requests. Assign Sinatra an issue, mention it in Slack, or start a task from code, and it writes the change in its own sandbox and opens a draft pull request for your team to review.

With this client you can start, follow and stop Sinatra tasks and delegate Linear and GitHub issues from your own scripts, CI jobs and tools, through the [Sinatra API](https://docs.sinatra.dev/docs/api-reference).

It runs on Node.js 20 and later, ships ESM and CommonJS builds with types, and has no runtime dependencies. The client is generated from the API's [OpenAPI spec](https://api.sinatra.dev/openapi.json) and released automatically when the spec changes. There are also official SDKs for [Python](https://github.com/sinatra-dev/sinatra-python) and [Go](https://github.com/sinatra-dev/sinatra-go); see [SDKs](https://docs.sinatra.dev/docs/sdks).

## Install

```sh
npm install @sinatra-dev/sdk
```

## Quick start

```ts
import { Sinatra } from "@sinatra-dev/sdk";

const sinatra = new Sinatra(); // reads SINATRA_TOKEN
const me = await sinatra.me.get();
const workspace = me.workspaces[0];
if (!workspace) throw new Error("The token's user isn't in any workspace yet.");

const { task } = await sinatra.tasks.create(
  workspace.id,
  { prompt: "Fix the flaky login test", repo: "acme/web" },
  { idempotencyKey: "fix-flaky-login-1" },
);

// The turn is done when the task leaves these statuses (for example, it reaches replied or pr_open).
const WORKING = new Set(["pending", "investigating", "implementing", "rework"]);
let after: string | undefined;
for (;;) {
  const { status } = await sinatra.tasks.get(workspace.id, task.id);
  for await (const m of sinatra.messages.listAll(workspace.id, task.id, { after })) {
    console.log(`${m.role}: ${m.body}`);
    after = m.id;
  }
  if (!WORKING.has(status)) break;
  await new Promise((r) => setTimeout(r, 3000));
}
```

The API has no streaming. To wait for a reply, read the conversation after the last entry you've seen, and check the task's `status`: the agent posts one reply per turn, and the turn is done when the task stops working. The loop reads the status before the conversation, so it never stops before printing the reply that ended the turn. An unknown status counts as done, so the loop can't wait forever on a status added after this was written. See [How replies work](https://docs.sinatra.dev/docs/cli-and-api#how-replies-work).

## Examples

[`examples/`](examples) has small programs you can run as they are:

- [`delegate-issue.ts`](examples/delegate-issue.ts): hand Sinatra a Linear issue (`ENG-123`) or a GitHub issue (`acme/web#42`), for example from a CI job.
- [`search-issues.ts`](examples/search-issues.ts): list the open issues you could delegate, yours first.
- [`open-prs.ts`](examples/open-prs.ts): print the pull requests Sinatra has open in each workspace as a Markdown list, for a standup or a Slack post.

They import the package by name, so build it first. Node.js 22.18 or later runs the TypeScript directly:

```sh
npm ci && npm run build
SINATRA_TOKEN=sntr_... node examples/open-prs.ts
```

## Authentication

Create a personal access token on the [Access tokens](https://app.sinatra.dev/tokens) page (**CLI & API** in the dashboard). It starts with `sntr_` and acts as you in every workspace you belong to. The client reads it from the `SINATRA_TOKEN` environment variable, or you can pass it:

```ts
const sinatra = new Sinatra({ token: process.env.MY_TOKEN });
```

The constructor throws if it finds no token. Other options:

- `baseUrl`: defaults to `https://api.sinatra.dev`.
- `timeout`: how long each attempt may take, in milliseconds, before it's aborted with a `TimeoutError`. Defaults to 60 seconds; `0` turns it off. Values above 2^31−1 (about 24.8 days) are cut to that, the most `setTimeout` can wait.
- `fetch`: a `fetch` to use instead of the global one.

Every method takes `{ signal, timeout }` as its last argument: `signal` cancels the call, including a retry it's waiting to make, and `timeout` overrides the client's for that call.

```ts
await sinatra.tasks.get(workspaceId, taskId, { timeout: 5_000 });
```

## Operations

The namespaces mirror the API's operation ids:

| Method | Request |
| --- | --- |
| `me.get()` | `GET /v1/me` |
| `me.revokeToken()` | `DELETE /v1/me/token` |
| `tasks.list(workspaceId, { status?, limit?, cursor? })` | `GET /v1/workspaces/{workspaceId}/tasks` |
| `tasks.get(workspaceId, taskId)` | `GET /v1/workspaces/{workspaceId}/tasks/{taskId}` |
| `tasks.create(workspaceId, { prompt, title?, repo? }, { idempotencyKey? })` | `POST /v1/workspaces/{workspaceId}/tasks` |
| `tasks.stop(workspaceId, taskId)` | `POST /v1/workspaces/{workspaceId}/tasks/{taskId}/stop` |
| `messages.create(workspaceId, taskId, { text }, { idempotencyKey? })` | `POST /v1/workspaces/{workspaceId}/tasks/{taskId}/messages` |
| `messages.list(workspaceId, taskId, { after?, limit? })` | `GET /v1/workspaces/{workspaceId}/tasks/{taskId}/messages` |
| `tickets.search(workspaceId, { q?, repo? })` | `GET /v1/workspaces/{workspaceId}/tickets` |
| `tickets.delegate(workspaceId, { source: "linear", id } \| { source: "github", repo, number })` | `POST /v1/workspaces/{workspaceId}/tickets/delegate` |

`tasks.listAll` and `messages.listAll` page through everything for you:

```ts
for await (const task of sinatra.tasks.listAll(workspaceId, { status: "pr_open" })) {
  console.log(task.id, task.title);
}
```

Fields such as `status`, `source`, `role`, `kind` and the error `code` are plain strings, and the API adds new values over time. Handle values you don't recognise.

## Retries and idempotency

`tasks.create` and `messages.create` always send an `Idempotency-Key`. If you don't pass one, the client makes a random UUID. Every retry of a call sends the same key, so a retried start never starts a second task. Pass your own key to make a retry safe across process restarts too.

The client retries a request up to 3 times when it's safe to repeat:

- `429`: after the `Retry-After` the server sends, at most 60 seconds.
- `503`: after 0.5s, then 1s, then 2s.

GETs, `me.revokeToken`, `tasks.create` and `messages.create` retry on both. `tasks.stop` retries on `503` only. `tickets.delegate` takes no idempotency key and is never retried. Other errors, timeouts and network failures are never retried.

## Errors

An error response throws a `SinatraError`:

```ts
import { SinatraError } from "@sinatra-dev/sdk";

try {
  await sinatra.tasks.stop(workspaceId, task.id);
} catch (err) {
  if (err instanceof SinatraError && err.code === "not_running") {
    // the task had already stopped
  } else {
    throw err;
  }
}
```

| Field | |
| --- | --- |
| `status` | The HTTP status. |
| `code` | The API's `error` code, such as `capacity_full`. `http_error` when the response carried none, such as an HTML error page from a proxy. |
| `reason` | A sentence for a person. Don't branch on it. |
| `requestId` | The request's id. Include it when you contact support. |
| `body` | The response body: the parsed JSON, or the text. Refusals carry extra fields here, such as `billingUrl`. |
| `headers` | The response headers. |

Network failures, timeouts and aborts are not wrapped: they reject with the error `fetch` threw, the `TimeoutError`, or your signal's reason.

The [API reference](https://docs.sinatra.dev/docs/api-reference) lists every operation's error codes.

## Versions

Releases follow semver. While the version is `0.x`, a breaking API change bumps the minor version and anything else bumps the patch. From `1.0`, breaking changes bump the major version and additions bump the minor.

## Development

```sh
npm ci
npm run tools          # installs the pinned oasdiff into .tools/bin
npm run generate       # regenerates src/generated from openapi.json
npm run typecheck && npm run build
npm test               # wrapper tests against a local stub server
npm run test:contract  # every operation against a Prism mock of openapi.json
npm run test:contract:future  # the same, with new fields added to the spec
npm run test:version   # scripts/next-version.sh
```

`src/generated` is written by `@hey-api/openapi-ts` and never edited by hand; CI fails if it differs from what `openapi.json` generates. `openapi.json` is updated by the release workflow. See [RELEASING.md](RELEASING.md).

## License

MIT
