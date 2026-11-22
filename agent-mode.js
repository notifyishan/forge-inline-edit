const vscode = require("vscode");
const path = require("node:path");
const { request, runTurn, withGeneration } = require("./trueforge");
const { startServer, openWorkspaceTools } = require("./workspace-tools");
const agentSpec = require("./agent-definition.json");

async function reviewChanges(files) {
  const workspaceEdit = new vscode.WorkspaceEdit();
  const snapshots = [];
  for (const file of files.values()) {
    const document = await vscode.workspace.openTextDocument(file.uri);
    if (document.getText() !== file.original)
      throw new Error(file.path + " changed during the request.");
    snapshots.push({ document, original: file.original });
    for (const change of file.changes) {
      const start = document.positionAt(change.start);
      const end = document.positionAt(change.end);
      const original = await vscode.workspace.openTextDocument({
        language: document.languageId,
        content: file.original,
      });
      const proposed = await vscode.workspace.openTextDocument({
        language: document.languageId,
        content:
          file.original.slice(0, change.start) +
          change.after +
          file.original.slice(change.end),
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        original.uri,
        proposed.uri,
        "Forge: " + file.path + " (line " + (start.line + 1) + ")",
        { selection: new vscode.Range(start, start) },
      );
      const decision = await vscode.window.showInformationMessage(
        "Review the proposed edit to " + file.path + ".",
        "Accept",
        "Reject",
        "Cancel All",
      );
      if (!decision || decision === "Cancel All") return;
      if (decision === "Accept") {
        workspaceEdit.replace(
          file.uri,
          new vscode.Range(start, end),
          change.after,
        );
      }
    }
  }

  const currentFiles = await Promise.all(
    snapshots.map(async ({ document, original }) => ({
      current: await vscode.workspace.openTextDocument(document.uri),
      original,
    })),
  );

  if (
    currentFiles.some(({ current, original }) => current.getText() !== original)
  ) {
    throw new Error(
      "A source file changed during review. Run Agent Mode again.",
    );
  }
  if (
    workspaceEdit.size &&
    !(await vscode.workspace.applyEdit(workspaceEdit))
  ) {
    throw new Error("VS Code could not apply the accepted changes.");
  }
}

async function agentMode(prompt, output) {
  const active = vscode.window.activeTextEditor?.document;
  const folders = vscode.workspace.workspaceFolders || [];
  const folder = (active && vscode.workspace.getWorkspaceFolder(active.uri)) ||
    (folders.length === 1 ? folders[0] : undefined);
  if (!folder || !vscode.workspace.isTrusted || folder.uri.scheme !== "file") {
    throw new Error("Open a trusted local project before running Agent Mode.");
  }
  const files = await withGeneration("Forge is preparing a project edit", async (signal, progress) => {
    const workspace = await openWorkspaceTools(folder, signal, (tool, target) => {
      output.appendLine(tool + " " + target);
      progress.report({ message: tool + " " + target });
    });
    let connector;
    try {
      connector = await startServer();
      const { manifest } = connector;
      await request("/settings/mcp-servers", signal, { method: "POST", body: { manifest } });
      const hints = await workspace.suggestPaths(prompt);
      const excerpts = await workspace.startingExcerpts(hints);
      const activePath = active && vscode.workspace.getWorkspaceFolder(active.uri) === folder
        ? path.relative(folder.uri.fsPath, active.uri.fsPath).split(path.sep).join("/")
        : undefined;
      output.show(true);
      if (hints.length) output.appendLine("Context candidates: " + hints.map(({ path, reason }) => path + " (" + reason + ")").join(", "));
      await runTurn({
        instruction: [
          prompt,
          activePath && "Active editor: " + activePath,
          hints.length && "Automatically discovered candidate paths and line landmarks: " + JSON.stringify(hints),
          excerpts.length && "Numbered starter excerpts. These ranges can already be used for edit proposals: " + JSON.stringify(excerpts),
        ].filter(Boolean).join("\n\n"),
        spec: {
          ...agentSpec,
          mcp_servers: [{
            name: manifest.name,
            enable_tools: ["@all"],
            require_approval_for_tools: [],
            preload: true,
          }],
        },
        signal,
        output,
        onSession: (id) => output.appendLine("TrueForge session " + id),
      });
      if (!workspace.changes.length) {
        throw new Error("TrueForge finished without proposing a workspace edit.");
      }
      const proposals = new Map();
      for (const change of workspace.changes) {
        if (!proposals.has(change.path)) {
          proposals.set(change.path, { ...workspace.files.get(change.path), changes: [] });
        }
        proposals.get(change.path).changes.push(change);
      }
      return proposals;
    } finally {
      workspace.close();
      if (connector) {
        connector.close();
        void request("/settings/mcp-servers/" + connector.manifest.name, AbortSignal.timeout(3000), {
          method: "DELETE",
        }).catch(() => {});
      }
    }
  });
  if (files) await reviewChanges(files);
}

module.exports = { agentMode };
