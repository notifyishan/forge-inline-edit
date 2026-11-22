const vscode = require("vscode");
const { agentMode } = require("./agent-mode");
const { runTurn, withGeneration } = require("./trueforge");

function activate(context) {
  const output = vscode.window.createOutputChannel("Forge");
  context.subscriptions.push(output);
  const command = vscode.commands.registerCommand(
    "forgeExtension.inlineEdit",
    async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("Select some code first.");
        return;
      }
      const originalSelection = editor.selection;
      const originalVersion = editor.document.version;
      const selectedCode = editor.document.getText(originalSelection);
      const instruction = await vscode.window.showInputBox({
        prompt: "What should Forge change in the selected code?",
        placeHolder: "For example, treat 'off' and 'n' as false",
        validateInput: (value) =>
          value.trim() ? undefined : "Enter an instruction.",
      });

      if (instruction !== undefined) {
        try {
          output.show(true);
          const reply = await withGeneration("Forge is preparing an inline edit", (signal) =>
            runTurn({
              instruction: "Instruction: " + instruction.trim() + "\n\nSelected code:\n" + selectedCode,
              spec: { instructions: "Rewrite only the selected code. Return replacement code only, without Markdown fences." },
              signal,
              output,
              onSession: (id) => output.appendLine("TrueForge session " + id),
            }),
          );
          if (reply === undefined) return;
          if (typeof reply !== "string" || !reply.trim()) throw new Error("TrueForge returned an empty edit.");
          const replacementText = reply.replace(/^\s*```[^\n]*\n|\n```\s*$/g, "");
          const original = await vscode.workspace.openTextDocument({
            language: editor.document.languageId,
            content: selectedCode,
          });
          const proposed = await vscode.workspace.openTextDocument({
            language: editor.document.languageId,
            content: replacementText,
          });
          await vscode.commands.executeCommand(
            "vscode.diff", original.uri, proposed.uri, "Forge: Original ↔ Proposed",
          );
          const choice = await vscode.window.showInformationMessage(
            "Review the diff, then choose whether to apply the proposed edit.",
            "Accept", "Reject",
          );
          if (choice !== "Accept") return;
          if (editor.document.isClosed || editor.document.version !== originalVersion) {
            throw new Error("The original file changed. Run Forge: Inline Edit again.");
          }
          const eol = editor.document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
          let replacement = replacementText.replace(/\r\n|\r|\n/g, eol);
          if (selectedCode.endsWith("\n") && !replacement.endsWith(eol)) replacement += eol;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(editor.document.uri, originalSelection, replacement);
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code could not apply the edit.");
        } catch (error) {
          vscode.window.showErrorMessage(
            `TrueForge connection failed: ${error.message}`,
          );
        }
      }
    },
  );

  context.subscriptions.push(
    command,
    vscode.commands.registerCommand("forgeExtension.agentMode", async () => {
      const request = await vscode.window.showInputBox({
        prompt: "What should Forge change in this project?",
        validateInput: (value) =>
          value.trim() ? undefined : "Enter a request.",
      });

      if (request !== undefined) {
        try {
          await agentMode(request.trim(), output);
        } catch (error) {
          vscode.window.showErrorMessage("Forge Agent Mode: " + error.message);
        }
      }
    }),
  );
}

module.exports = { activate };
