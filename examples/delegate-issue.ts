// Hands Sinatra an issue you already have, the way assigning it in Linear or
// labelling it on GitHub would. Sinatra works on it in its own sandbox and
// opens a draft pull request.
//
//   node examples/delegate-issue.ts ENG-123          # a Linear issue
//   node examples/delegate-issue.ts acme/web#42      # a GitHub issue
import { Sinatra, type DelegateTicketRequest } from "@sinatra-dev/sdk";

const ref = process.argv[2];
if (!ref) {
  console.error("usage: node examples/delegate-issue.ts <ENG-123 | owner/name#42>");
  process.exit(2);
}

const github = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(ref);
const issue: DelegateTicketRequest = github
  ? { source: "github", repo: github[1]!, number: Number(github[2]) }
  : { source: "linear", id: ref };

const sinatra = new Sinatra(); // reads SINATRA_TOKEN
const me = await sinatra.me.get();
const workspace = me.workspaces[0];
if (!workspace) throw new Error("The token's user isn't in any workspace yet.");

await sinatra.tickets.delegate(workspace.id, issue);
console.log(`Delegated ${ref} in ${workspace.name}. Sinatra will open a draft pull request.`);
console.log("Follow it in the dashboard, or list open PRs with examples/open-prs.ts.");
