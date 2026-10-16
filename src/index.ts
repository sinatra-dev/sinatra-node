import { type Client, createClient, createConfig } from "./generated/client";
import * as api from "./generated/sdk.gen";
import type {
  CreateMessageRequest,
  CreateMessageResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DelegateTicketRequest,
  DelegateTicketResponse,
  Me,
  Message,
  MessageList,
  MessagesListData,
  StopTaskResponse,
  Task,
  TaskList,
  TasksListData,
  TicketSearchResult,
  TicketsSearchData,
} from "./generated/types.gen";
import { type CallOptions, RETRY_IDEMPOTENT, RETRY_NEVER, RETRY_UNAVAILABLE, type RetryOn, withRetries } from "./retry";

export { SinatraError } from "./error";
export type {
  CreateMessageRequest,
  CreateMessageResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DelegateGithubTicket,
  DelegateLinearTicket,
  DelegateTicketRequest,
  DelegateTicketResponse,
  Error as ErrorBody,
  Me,
  Message,
  MessageList,
  PullRequest,
  StopTaskResponse,
  Task,
  TaskList,
  Ticket,
  TicketSearchResult,
  Workspace,
} from "./generated/types.gen";

export const DEFAULT_BASE_URL = "https://api.sinatra.dev";
/** How long one attempt may take, by default. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export type { CallOptions };

export interface SinatraOptions {
  /** An API token (`sntr_...`). Defaults to the `SINATRA_TOKEN` environment variable. */
  token?: string;
  /** Defaults to `https://api.sinatra.dev`. */
  baseUrl?: string;
  /** A `fetch` to use instead of the global one. */
  fetch?: typeof fetch;
  /**
   * Milliseconds each attempt may take before it is aborted with a
   * `TimeoutError`. Defaults to 60 seconds; `0` for none. A call can
   * override it, and pass a `signal`, in its last argument.
   */
  timeout?: number;
}

export interface IdempotencyOptions extends CallOptions {
  /**
   * 1 to 128 printable ASCII characters, with no spaces. When you leave it
   * out, the client makes a random UUID. Either way, every retry of the call
   * sends the same key, so a retried start never starts a second task.
   */
  idempotencyKey?: string;
}

export type ListTasksQuery = NonNullable<TasksListData["query"]>;
export type ListMessagesQuery = NonNullable<MessagesListData["query"]>;
export type SearchTicketsQuery = NonNullable<TicketsSearchData["query"]>;

/**
 * A client for the Sinatra API. Its namespaces mirror the API's operations:
 * `me.get` is `GET /v1/me`, `tasks.create` is `POST /v1/workspaces/{workspaceId}/tasks`.
 *
 * Requests that are safe to repeat (GETs, the token DELETE, and starts and
 * messages, which always carry an `Idempotency-Key`) are retried up to 3 times
 * on `429` and `503`. `tasks.stop` is retried on `503` only. Errors throw
 * {@link SinatraError}.
 *
 * Reference: https://docs.sinatra.dev/docs/api-reference
 */
export class Sinatra {
  readonly me: MeApi;
  readonly tasks: TasksApi;
  readonly messages: MessagesApi;
  readonly tickets: TicketsApi;

  constructor(options: SinatraOptions = {}) {
    const token = options.token || envToken();
    if (!token) {
      throw new Error("No Sinatra API token: pass { token } or set SINATRA_TOKEN.");
    }
    const client = createClient(
      createConfig({
        baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
        auth: token,
        throwOnError: false,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
    );
    const ctx: Context = { client, timeout: options.timeout ?? DEFAULT_TIMEOUT_MS };
    this.me = new MeApi(ctx);
    this.tasks = new TasksApi(ctx);
    this.messages = new MessagesApi(ctx);
    this.tickets = new TicketsApi(ctx);
  }
}

/** What every namespace shares: the generated client and the default timeout. */
interface Context {
  client: Client;
  timeout: number;
}

/** Runs one call with the client's retry and timeout rules. */
function call<T>(
  ctx: Context,
  retryOn: RetryOn,
  options: CallOptions,
  attempt: (client: Client, signal: AbortSignal) => Promise<{ data?: T; error?: unknown; response?: Response }>,
): Promise<T> {
  const limits = { signal: options.signal, timeout: options.timeout ?? ctx.timeout };
  return withRetries(retryOn, limits, (signal) => attempt(ctx.client, signal));
}

export class MeApi {
  /** @internal */
  constructor(private readonly ctx: Context) {}

  /** `me.get`: the user the token acts as, and their workspaces. */
  get(options: CallOptions = {}): Promise<Me> {
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) => api.meGet({ client, signal }));
  }

  /** `me.revokeToken`: revokes the token this client sends. Later requests get `401`. */
  async revokeToken(options: CallOptions = {}): Promise<void> {
    await call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) => api.meRevokeToken({ client, signal }));
  }
}

export class TasksApi {
  /** @internal */
  constructor(private readonly ctx: Context) {}

  /** `tasks.list`: one page of the workspace's tasks, most recently active first. */
  list(workspaceId: string, query: ListTasksQuery = {}, options: CallOptions = {}): Promise<TaskList> {
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.tasksList({ client, signal, path: { workspaceId }, query: defined(query) }),
    );
  }

  /** Every task from `query.cursor` on (or from the start), following `nextCursor` page by page. */
  listAll(workspaceId: string, query: ListTasksQuery = {}, options: CallOptions = {}): AsyncGenerator<Task, void, undefined> {
    return paginate(
      query.cursor,
      (cursor) => this.list(workspaceId, { ...query, cursor }, options),
      (page) => [page.tasks, page.nextCursor],
    );
  }

  /** `tasks.get`: one task, wherever it started. */
  get(workspaceId: string, taskId: string, options: CallOptions = {}): Promise<Task> {
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.tasksGet({ client, signal, path: { workspaceId, taskId } }),
    );
  }

  /**
   * `tasks.create`: starts a task. Answers once the task is made, not when it's done:
   * poll `tasks.get` and `messages.list` to follow it.
   */
  create(workspaceId: string, body: CreateTaskRequest, options: IdempotencyOptions = {}): Promise<CreateTaskResponse> {
    const key = options.idempotencyKey ?? crypto.randomUUID();
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.tasksCreate({ client, signal, path: { workspaceId }, body, headers: { "Idempotency-Key": key } }),
    );
  }

  /** `tasks.stop`: stops the task's running turn. A task that isn't running is `409 not_running`. */
  stop(workspaceId: string, taskId: string, options: CallOptions = {}): Promise<StopTaskResponse> {
    return call(this.ctx, RETRY_UNAVAILABLE, options, (client, signal) =>
      api.tasksStop({ client, signal, path: { workspaceId, taskId } }),
    );
  }
}

export class MessagesApi {
  /** @internal */
  constructor(private readonly ctx: Context) {}

  /** `messages.create`: sends a follow-up on a task started from the API, CLI, MCP or dashboard. */
  create(
    workspaceId: string,
    taskId: string,
    body: CreateMessageRequest,
    options: IdempotencyOptions = {},
  ): Promise<CreateMessageResponse> {
    const key = options.idempotencyKey ?? crypto.randomUUID();
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.messagesCreate({ client, signal, path: { workspaceId, taskId }, body, headers: { "Idempotency-Key": key } }),
    );
  }

  /**
   * `messages.list`: one page of the task's conversation, oldest first. To wait
   * for a reply, poll with `after` set to the `id` of the last entry you read.
   */
  list(workspaceId: string, taskId: string, query: ListMessagesQuery = {}, options: CallOptions = {}): Promise<MessageList> {
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.messagesList({ client, signal, path: { workspaceId, taskId }, query: defined(query) }),
    );
  }

  /** Every entry after `query.after` (or from the start), following `next` page by page. */
  listAll(
    workspaceId: string,
    taskId: string,
    query: ListMessagesQuery = {},
    options: CallOptions = {},
  ): AsyncGenerator<Message, void, undefined> {
    return paginate(
      query.after,
      (after) => this.list(workspaceId, taskId, { ...query, after }, options),
      (page) => [page.messages, page.next],
    );
  }
}

export class TicketsApi {
  /** @internal */
  constructor(private readonly ctx: Context) {}

  /** `tickets.search`: open Linear and GitHub issues you could delegate. */
  search(workspaceId: string, query: SearchTicketsQuery = {}, options: CallOptions = {}): Promise<TicketSearchResult> {
    return call(this.ctx, RETRY_IDEMPOTENT, options, (client, signal) =>
      api.ticketsSearch({ client, signal, path: { workspaceId }, query: defined(query) }),
    );
  }

  /**
   * `tickets.delegate`: hands Sinatra an existing issue as you. Not retried:
   * the operation takes no `Idempotency-Key`.
   */
  delegate(workspaceId: string, body: DelegateTicketRequest, options: CallOptions = {}): Promise<DelegateTicketResponse> {
    return call(this.ctx, RETRY_NEVER, options, (client, signal) =>
      api.ticketsDelegate({ client, signal, path: { workspaceId }, body }),
    );
  }
}

async function* paginate<P, I>(
  start: string | undefined,
  fetchPage: (cursor: string | undefined) => Promise<P>,
  split: (page: P) => [I[], string | null | undefined],
): AsyncGenerator<I, void, undefined> {
  let cursor = start;
  do {
    const [items, next] = split(await fetchPage(cursor));
    yield* items;
    cursor = next ?? undefined;
  } while (cursor);
}

/** Drops `undefined` values so they never reach the query string. */
function defined<T extends object>(query: T): T {
  return Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)) as T;
}

function envToken(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env.SINATRA_TOKEN || undefined;
}
