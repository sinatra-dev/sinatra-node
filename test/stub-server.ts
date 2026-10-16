// A scripted HTTP server for the wrapper tests. Each request takes the next
// queued reply; every request is recorded so tests can inspect what was sent.
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StubReply {
  status: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a string is sent as is; undefined sends no body. */
  body?: unknown;
  /** Never answer: the request hangs until the client gives up. */
  hang?: boolean;
}

export interface Stub {
  url: string;
  requests: RecordedRequest[];
  reply(...replies: StubReply[]): void;
  close(): Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const queue: StubReply[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: new URL(req.url ?? "/", "http://stub"),
        headers: req.headers,
        body,
      });
      const reply = queue.shift() ?? { status: 599, body: { error: "stub_exhausted" } };
      if (reply.hang) return;
      const headers: Record<string, string> = { ...reply.headers };
      if (reply.body === undefined) {
        res.writeHead(reply.status, headers);
        res.end();
        return;
      }
      const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      if (typeof reply.body !== "string") headers["content-type"] ??= "application/json";
      res.writeHead(reply.status, headers);
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (...replies) => queue.push(...replies),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
