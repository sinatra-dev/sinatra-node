# @sinatra-dev/sdk

A TypeScript client for the [Sinatra API](https://docs.sinatra.dev/docs/api-reference): start, follow and stop Sinatra tasks, and delegate Linear and GitHub issues.

It runs on Node.js 20 and later, ships ESM and CommonJS builds with types, and has no runtime dependencies. The client is generated from the API's [OpenAPI spec](https://api.sinatra.dev/openapi.json) and released automatically when the spec changes.

## Install

```sh
npm install @sinatra-dev/sdk
```

## Quick start

```ts
import { Sinatra } from "@sinatra-dev/sdk";

const sinatra = new Sinatra(); // reads SINATRA_TOKEN
const me = await sinatra.me.get();
const workspaceId = me.workspaces[0].id;

const { task } = await sinatra.tasks.create(
  workspaceId,
  { prompt: "Fix the flaky login test", repo: "acme/web" },
  { idempotencyKey: "fix-flaky-login-1" },
);

let after: string | undefined;
let replied = false;
while (!replied) {
  const page = await sinatra.messages.list(workspaceId, task.id, { after });
  for (const m of page.messages) {
    console.log(`${m.role}: ${m.body}`);
    replied ||= m.role === "agent";
    after = m.id;
  }
  if (!replied) await new Promise((r) => setTimeout(r, 5000));
}
```

The API has no streaming: poll `messages.list` with `after` set to the last entry you read. `tasks.get` tells you where the task is (`status`, `queued`, `pullRequest`).

## Authentication

Create a personal access token on the [Access tokens](https://app.sinatra.dev/tokens) page (**CLI & API** in the dashboard). It starts with `sntr_` and acts as you in every workspace you belong to. The client reads it from the `SINATRA_TOKEN` environment variable, or you can pass it:

```ts
const sinatra = new Sinatra({ token: process.env.MY_TOKEN });
```

The constructor throws if it finds no token. Other options: `baseUrl` (defaults to `https://api.sinatra.dev`) and `fetch`, to use a `fetch` other than the global one.

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

GETs, `me.revokeToken`, `tasks.create` and `messages.create` retry on both. `tasks.stop` retries on `503` only. `tickets.delegate` takes no idempotency key and is never retried. Other errors are never retried.

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

Network failures are not wrapped: they reject with the error `fetch` threw.

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
npm run test:version   # scripts/next-version.sh
```

`src/generated` is written by `@hey-api/openapi-ts` and never edited by hand; CI fails if it differs from what `openapi.json` generates. `openapi.json` is updated by the release workflow. See [RELEASING.md](RELEASING.md).

## License

MIT
