const http = require("node:http");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { realpath } = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const vscode = require("vscode");

const exec = promisify(execFile);
const CONNECTOR = "forge-workspace";
const PYTHON_CHECK = [
  "import ast, json, sys",
  "previous, proposed = json.loads(sys.stdin.buffer.read())",
  "original = ast.parse(previous)",
  "updated = ast.parse(proposed)",
  "from collections import Counter",
  "def definitions(tree):",
  "    return Counter(node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)))",
  "before, after = definitions(original), definitions(updated)",
  "duplicates = sorted(name for name in after if after[name] > max(1, before[name]))",
  "if duplicates:",
  "    raise ValueError('Duplicate top-level definitions: ' + ', '.join(duplicates))",
].join("\n");
const schema = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const string = { type: "string", minLength: 1 };
const line = { type: "integer", minimum: 1 };
const readRange = schema({ path: string, start_line: line, end_line: line }, ["path"]);
const proposedEdit = schema({
  path: string,
  operation: { enum: ["insert_before", "replace"] },
  start_line: line,
  end_line: line,
  text: { type: "string" },
}, ["path", "operation", "start_line", "text"]);
const tools = [
  {
    name: "search_workspace",
    description: "Search source paths and lines for a literal term or symbol. Returns at most 24 ranked matches.",
    inputSchema: schema({ query: string }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_file",
    description: "Read an exact source excerpt with its first and last line numbers. Limit each read to 180 lines.",
    inputSchema: readRange,
    annotations: { readOnlyHint: true },
  },
  {
    name: "read_files",
    description: "Read several exact source ranges in one call. Each range follows the read_file rules. Use this to compare related source, tests and documentation in one step.",
    inputSchema: schema({ ranges: { type: "array", minItems: 1, maxItems: 4, items: readRange } }),
    annotations: { readOnlyHint: true },
  },
  {
    name: "propose_edits",
    description: "Queue a batch of edits against exact line numbers from read_file or read_files. insert_before inserts complete lines immediately before start_line. replace replaces the inclusive range from start_line to end_line. Leave all line number prefixes out of text. If any edit is invalid, nothing in this batch queues.",
    inputSchema: schema({ edits: { type: "array", minItems: 1, maxItems: 12, items: proposedEdit } }),
  },
  {
    name: "run_terminal",
    description: "Run a read-only git status or git diff summary against the current workspace. Proposed edits are staged in memory until after review.",
    inputSchema: schema({ command: { enum: ["status", "diff"] } }),
    annotations: { readOnlyHint: true },
  },
];

let activeRun;

async function checkPython(file, projected, signal) {
  await new Promise((resolve, reject) => {
    const child = spawn("python", ["-I", "-c", PYTHON_CHECK], {
      windowsHide: true, stdio: ["pipe", "ignore", "pipe"], signal,
    });
    let errorText = "";
    const timeout = setTimeout(() => child.kill(), 5000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { errorText = (errorText + text).slice(-1600); });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      if (error.code === "ENOENT") resolve();
      else reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (status === 0) resolve();
      else reject(new Error(file.path + " failed Python validation: " +
        (errorText.trim().split("\n").at(-1) || "Python validation timed out.")));
    });
    child.stdin.end(JSON.stringify([file.original, projected]));
  });
}

async function startServer() {
  const token = randomBytes(32).toString("hex");
  const listener = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer " + token) {
      response.writeHead(401).end();
      return;
    }
    void serve(request, response);
  });
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  return {
    manifest: {
      name: CONNECTOR + "-" + randomBytes(6).toString("hex"),
      type: "remote",
      url: "http://127.0.0.1:" + listener.address().port + "/mcp",
      description: "Search, read and propose reviewed workspace changes from VS Code.",
      auth: { type: "header", headers: { Authorization: "Bearer " + token } },
    },
    close() {
      listener.close();
      listener.closeAllConnections();
    },
  };
}

async function serve(request, response) {
  if (request.url !== "/mcp" || request.headers.origin) {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  let message;
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 160000) throw new Error("Request is too large.");
      chunks.push(chunk);
    }
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result = await dispatch(message);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  } catch (error) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32603, message: error.message },
    }));
  }
}

async function dispatch({ method, params }) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: ["2025-03-26", "2025-06-18", "2025-11-25"].includes(params.protocolVersion)
          ? params.protocolVersion : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: CONNECTOR, version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const run = activeRun;
      try {
        if (!run) throw new Error("No active Forge workspace run.");
        const result = await run.call(params.name, params.arguments || {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    }
    default:
      throw new Error("Unsupported MCP method.");
  }
}

async function openWorkspaceTools(folder, signal, onTool) {
  if (activeRun) throw new Error("An Agent Mode run is already in progress.");
  const root = await realpath(folder.uri.fsPath);
  const files = new Map();
  const seenRanges = new Map();
  const changes = [];
  let index;

  async function readFile(relative) {
    signal.throwIfAborted();
    if (typeof relative !== "string" || !relative || relative.length > 500 ||
        relative.includes("\\") || relative.includes(":") ||
        relative.split("/").some((part) => !part || part.startsWith(".")) ||
        !/\.(py|[cm]?js|[jt]sx?|md|rst|toml|json|ya?ml|txt|css|html|go|rs|java)$/i.test(relative) ||
        /(^|\/)(venv|node_modules|build|dist)(\/|$)|secret|credential|package-lock\.json/i.test(relative)) {
      throw new Error("Choose a visible source path relative to the workspace.");
    }
    if (files.has(relative)) return files.get(relative);
    const uri = vscode.Uri.joinPath(folder.uri, relative);
    const resolved = await realpath(uri.fsPath);
    const local = path.relative(root, resolved);
    if (!local || local === ".." || local.startsWith(".." + path.sep) || path.isAbsolute(local)) {
      throw new Error("This file resolves outside the workspace.");
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > 160000) {
      throw new Error("This source file exceeds the read limit or is a link.");
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const file = { path: relative, uri, original: document.getText() };
    files.set(relative, file);
    return file;
  }

  async function findFiles() {
    return index ??= await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.{py,js,ts,tsx,jsx,md,rst,toml,json,yml,yaml,go,rs,java}"),
      new vscode.RelativePattern(folder, "**/{.*,node_modules,venv,build,dist}/**"),
      1000,
    );
  }

  function relativePath(uri) {
    return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
  }

  async function search(query) {
    if (typeof query !== "string" || !query.trim() || query.length > 160) {
      throw new Error("Enter one search term up to 160 characters.");
    }
    const needle = query.toLowerCase().trim();
    const results = [];
    for (const uri of await findFiles()) {
      signal.throwIfAborted();
      const relative = relativePath(uri);
      let file;
      try { file = await readFile(relative); } catch { continue; }
      const base = path.posix.basename(relative).toLowerCase();
      const nameScore = base === needle || base.split(".")[0] === needle ? 8 : base.includes(needle) ? 4 : 0;
      if (nameScore) results.push({ path: relative, score: nameScore });
      let hits = 0;
      for (const [offset, source] of file.original.split(/\r?\n/).entries()) {
        if (source.toLowerCase().includes(needle)) {
          results.push({ path: relative, line: offset + 1, text: source.slice(0, 220), score: nameScore + 1 });
          if (++hits === 3) break;
        }
      }
    }
    return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 24);
  }

  async function excerpt(args) {
    const file = await readFile(args.path);
    const lines = file.original.split(/\r?\n/);
    const start = args.start_line ?? 1;
    const end = args.end_line ?? start + 119;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 ||
        start > lines.length || end < start || end - start >= 240) {
      throw new Error("Choose a range of up to 240 source lines.");
    }
    const last = Math.min(end, lines.length);
    const text = lines.slice(start - 1, last).map((line, index) => (start + index) + " | " + line).join("\n");
    if (text.length > 16000) throw new Error("Choose a shorter excerpt under 16,000 characters.");
    if (!seenRanges.has(file.path)) seenRanges.set(file.path, []);
    seenRanges.get(file.path).push({ start, last });
    return { path: file.path, start_line: start, end_line: last, total_lines: lines.length, text };
  }

  async function validateEdit(args, pending) {
    const file = await readFile(args.path);
    const first = args.start_line;
    const last = args.end_line ?? first;
    const insert = args.operation === "insert_before";
    const ranges = seenRanges.get(file.path) || [];
    if ((!insert && args.operation !== "replace") || !Number.isInteger(first) ||
        !Number.isInteger(last) || last < first || last - first >= 240 ||
        (insert && last !== first) || typeof args.text !== "string" || args.text.length > 24000 ||
        !ranges.some((range) => first >= range.start && last <= range.last)) {
      const available = ranges.slice(-6).map(({ start, last }) => start + "–" + last).join(", ");
      throw new Error("Use valid original line numbers in " + file.path +
        (available ? ". Recently read ranges: " + available + "." : ". Read the target area first."));
    }
    const starts = [0, ...Array.from(file.original.matchAll(/\n/g), (match) => match.index + 1)];
    const start = starts[first - 1];
    const end = insert ? start : starts[last] ?? file.original.length;
    const eol = file.original.includes("\r\n") ? "\r\n" : "\n";
    let replacement = args.text;
    if (/\\n(?=\\n|[ \t]+\S)|\\"/.test(replacement) && !/(?<!\\)"/.test(replacement)) {
      try {
        replacement = JSON.parse('"' + replacement.replace(/\r?\n/g, "\\n") + '"');
      } catch {
        // Keep literal source text if the argument is not an extra JSON string.
      }
    }
    let after = replacement.replace(/\r\n|\r|\n/g, eol);
    if (after && (end < file.original.length || file.original.endsWith("\n")) && !after.endsWith(eol)) after += eol;
    if (file.original.slice(start, end) === after ||
        [...changes, ...pending].some((item) => item.path === file.path &&
          (item.start === start || (start < item.end && end > item.start)))) {
      throw new Error("The edit in " + file.path + " must be a distinct, nonoverlapping change.");
    }
    return { path: file.path, after, start, end, line: first };
  }

  let staging = Promise.resolve();
  function stage(edits) {
    const task = staging.then(async () => {
      if (!Array.isArray(edits) || !edits.length || edits.length > 12 || edits.length + changes.length > 20) {
        throw new Error("Queue up to 12 edits per batch and 20 per request.");
      }
      const pending = [];
      for (const edit of edits) pending.push(await validateEdit(edit, pending));
      for (const relative of new Set(pending.map((edit) => edit.path))) {
        if (!relative.endsWith(".py")) continue;
        const file = files.get(relative);
        let projected = file.original;
        for (const edit of [...changes, ...pending].filter((change) => change.path === relative).sort((a, b) => b.start - a.start)) {
          projected = projected.slice(0, edit.start) + edit.after + projected.slice(edit.end);
        }
        await checkPython(file, projected, signal);
      }
      signal.throwIfAborted();
      changes.push(...pending);
      return pending.map(({ path, line }) => ({ queued: true, path, line }));
    });
    staging = task.catch(() => {});
    return task;
  }

  const run = {
    files,
    changes,
    async suggestPaths(prompt) {
      const terms = new Set(prompt.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) || []);
      const hints = [];
      for (const uri of await findFiles()) {
        const relative = relativePath(uri);
        if (!relative || relative.split("/").some((part) => part.startsWith("."))) continue;
        const stem = path.posix.basename(relative, path.posix.extname(relative)).toLowerCase();
        const hits = [...new Set(stem.split(/[^a-z0-9]+/))].filter((term) => terms.has(term) && term !== "test");
        if (hits.length) {
          hints.push({ path: relative, reason: hits.join(", "), score: hits.length * 3 + Number(terms.has(stem)) });
        }
      }
      const shortlisted = hints.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 12);
      return Promise.all(shortlisted.map(async (hint) => {
        let file;
        try { file = await readFile(hint.path); }
        catch { return hint; }
        const lines = file.original.split(/\r?\n/);
        const outline = lines.flatMap((source, index) => {
          const heading = /^(?:#{1,4}\s+\S|[A-Z].{2,70})$/.test(source) &&
            (/^#{1,4}\s/.test(source) || /^[-=~^]{3,}$/.test(lines[index + 1] || ""));
          const declaration = /^(?:async )?(?:def|class|function|export class)\s+[A-Za-z_]/.test(source);
          const registration = /^\s*[@\w.]+\.add_command\(/.test(source);
          const moduleBinding = /^[a-z_]\w* = [A-Z]\w*\(/.test(source);
          if (!heading && !declaration && !registration && !moduleBinding) return [];
          const score = Number(heading || declaration) + 2 * Number(registration || moduleBinding) +
            2 * Number(/command|entry|register|help|shell/i.test(source)) +
            [...terms].filter((term) => source.toLowerCase().includes(term)).length;
          return [{ line: index + 1, label: source.trim().slice(0, 110), score }];
        });
        hint.landmarks = outline.sort((a, b) => b.score - a.score || a.line - b.line)
          .slice(0, 12).map(({ line, label }) => [line, label]).sort((a, b) => a[0] - b[0]);
        return hint;
      }));
    },
    async startingExcerpts(hints) {
      const excerpts = [];
      let remaining = 9000;
      const groups = [
        hints.find(({ path }) => path.startsWith("src/")),
        hints.find(({ path }) => path.startsWith("tests/")),
        hints.find(({ path }) => path.startsWith("docs/")),
      ].filter(Boolean);
      for (const hint of groups) {
        const landmarks = hint.landmarks || [];
        const anchors = landmarks.filter(([, name]) => /\.add_command\(|^[a-z_]\w* = [A-Z]\w*\(/.test(name));
        const seeds = (anchors.length ? [anchors[0], anchors.at(-1)] : landmarks.slice(0, 3));
        for (const line of new Set(seeds.map(([line]) => line))) {
          const range = await excerpt({ path: hint.path, start_line: Math.max(1, line - 4), end_line: line + 9 })
            .catch(() => undefined);
          if (!range) continue;
          const size = range.text.length;
          if (size <= remaining) {
            excerpts.push(range);
            remaining -= size;
          }
        }
      }
      return excerpts;
    },
    async call(name, args) {
      signal.throwIfAborted();
      onTool(name, args.path || args.query || args.command || "");
      switch (name) {
        case "search_workspace":
          return search(args.query);
        case "read_file":
          return excerpt(args);
        case "read_files":
          if (!Array.isArray(args.ranges) || !args.ranges.length || args.ranges.length > 4) {
            throw new Error("Provide up to four source ranges.");
          }
          return Promise.all(args.ranges.map(async (range) => {
            try { return await excerpt(range); }
            catch (error) { return { path: range?.path, error: error.message }; }
          }));
        case "propose_edits":
          return stage(args.edits);
        case "run_terminal": {
          if (!["status", "diff"].includes(args.command)) throw new Error("Choose status or diff.");
          const gitArgs = args.command === "status"
            ? ["--no-optional-locks", "status", "--short"]
            : ["--no-optional-locks", "--no-pager", "diff", "--no-ext-diff", "--stat"];
          const { stdout } = await exec("git", gitArgs, { cwd: root, timeout: 8000, signal, maxBuffer: 32000 });
          return stdout;
        }
        default:
          throw new Error("Unknown workspace tool.");
      }
    },
    close() {
      if (activeRun === run) activeRun = undefined;
    },
  };
  if (activeRun) throw new Error("An Agent Mode run is already in progress.");
  activeRun = run;
  return run;
}

module.exports = { startServer, openWorkspaceTools };
