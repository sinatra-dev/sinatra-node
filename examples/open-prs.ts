// Prints every pull request Sinatra has open and waiting for review, in each
// of your workspaces, as a Markdown list you can paste into a standup or a
// Slack channel.
//
//   node examples/open-prs.ts
import { Sinatra } from "@sinatra-dev/sdk";

const sinatra = new Sinatra(); // reads SINATRA_TOKEN
const me = await sinatra.me.get();

for (const workspace of me.workspaces) {
  const lines: string[] = [];
  for await (const task of sinatra.tasks.listAll(workspace.id, { status: "pr_open" })) {
    if (!task.pullRequest) continue;
    lines.push(`- [${task.title ?? task.pullRequest.url}](${task.pullRequest.url}) in ${task.repo ?? "?"}`);
  }
  console.log(`## ${workspace.name}: ${lines.length} open pull request${lines.length === 1 ? "" : "s"}`);
  if (lines.length > 0) console.log(lines.join("\n"));
  console.log();
}
