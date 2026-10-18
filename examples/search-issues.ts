// Lists open Linear and GitHub issues you could hand to Sinatra, yours first.
// Pass one to examples/delegate-issue.ts to delegate it.
//
//   node examples/search-issues.ts                    # everything open
//   node examples/search-issues.ts "flaky test"       # matching text
//   node examples/search-issues.ts "" acme/web        # search acme/web first on GitHub
import { Sinatra } from "@sinatra-dev/sdk";

const [q, repo] = process.argv.slice(2);

const sinatra = new Sinatra(); // reads SINATRA_TOKEN
const me = await sinatra.me.get();
const workspace = me.workspaces[0];
if (!workspace) throw new Error("The token's user isn't in any workspace yet.");

const result = await sinatra.tickets.search(workspace.id, { q: q || undefined, repo: repo || undefined });
if (!result.linear.connected && !result.github.connected) {
  console.log(`${workspace.name} isn't connected to Linear or GitHub yet.`);
}
for (const ticket of result.tickets) {
  console.log(`${ticket.yours ? "*" : " "} ${ticket.identifier.padEnd(24)} ${ticket.title}`);
}
const n = result.tickets.length;
console.log(`\n${n} issue${n === 1 ? "" : "s"}. * = assigned to you or written by you.`);
