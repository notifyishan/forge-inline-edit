# Forge Inline Edit

A VS Code extension that uses the local TrueForge harness for inline edits and repository-wide maintenance. The editor handles previews and applies the accepted changes as a single workspace edit.

## Starting point

Original VS Code extension built from scratch. TrueForge runs as a local dependency. The demo target is [pallets/flask 3.1.3](https://github.com/pallets/flask/tree/3.1.3), commit `22d92470`, in a separate checkout.

## Setup

1. Install VS Code 1.100 or later, Git, and Node.js 24 LTS. Start TrueForge in local mode on port 8790. The allowlist below permits only the loopback host used by the extension's temporary, authenticated MCP listener.

   ```powershell
   $env:OUTBOUND_URL_ALLOWED_HOSTS = '["127.0.0.1"]'
   npx @truefoundry/trueforge@0.185.1
   ```

   In Bash use `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.185.1`.
2. In TrueForge **Settings → Models**, configure a model provider. Set **Forge Extension: Model** in VS Code to its provider/model identifier. See `model.example.json` for the extension setting. Provider credentials belong in TrueForge.
3. From the extension directory, launch a Development Host using PowerShell. Replace the example Flask path with your checkout path.

   ```powershell
   code --new-window "--extensionDevelopmentPath=$($PWD.Path)" "C:\path\to\flask"
   ```

4. Use **Forge: Inline Edit** from the Command Palette or press **Ctrl+K**, then **Ctrl+Shift+E**, with code selected. Use **Forge: Agent Mode** to propose a project change from a single prompt. Open **View → Output → Forge** to see session IDs, streamed model output and tool activity.

The extension loads `agent-definition.json` into an inline TrueForge session. It automatically registers a temporary authenticated loopback MCP connector for Agent Mode. No manual agent import is required.

## Build and verification

The extension uses Node and VS Code APIs and requires no bundling. Check its JavaScript with `node --check`. See the official [Round 1 problem statement](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf) for the exact demo prompts.

| Capability | Implementation |
| --- | --- |
| Context | Agent-driven literal search with ranked path and line matches, bounded reads and support for explicit file and symbol mentions in the request. |
| Tools | Search and read, propose edits against numbered ranges in a frozen source snapshot, and run read-only Git status or diff statistics. All edits remain in memory. |
| Review | A VS Code side-by-side preview per proposed edit. Choose Accept, Reject or Cancel All. Forge checks the current file contents before applying the accepted set. Use VS Code Undo to reverse it. |
| Failure handling | The client reads TrueForge server-sent events, sets a generation deadline, and asks TrueForge to cancel the turn if local generation stops early. |

## Limitations

The terminal tool is restricted to Git inspection. It cannot launch tests, so run the requested verification in the integrated terminal after review. Proposed edits target existing supported text files only. Search is literal and capped at 1,000 candidate files. The extension requires a working local TrueForge service and configured model.
