const vscode = require("vscode");

const API = "http://localhost:8790/api/v1";
const RUNTIME = {
  ask_user_questions: { enabled: false },
  dynamic_sub_agents: { enabled: false },
  generative_ui: { enabled: false },
  iteration_limit: 18,
};

async function request(path, signal, { method = "GET", body, stream = false } = {}) {
  let response;
  try {
    response = await fetch(API + path, {
      method,
      signal,
      headers: {
        Accept: stream ? "text/event-stream" : "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Could not reach TrueForge on port 8790. Check that the local server is running.");
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.message || payload.error?.message;
    throw new Error(`TrueForge returned HTTP ${response.status}${typeof detail === "string" ? ": " + detail.slice(0, 300) : "."}`);
  }
  if (stream) {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new Error("TrueForge returned an unexpected response instead of a stream.");
    }
    return response;
  }
  if (response.status === 204) return;
  return (await response.json()).data;
}

async function* events(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") yield JSON.parse(data);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function runTurn({ instruction, spec, signal, output, onSession }) {
  const model = vscode.workspace.getConfiguration("forgeExtension").get("model");
  const session = await request("/sessions", signal, {
    method: "POST",
    body: { agent: { spec: { model: { name: model }, config: RUNTIME, ...spec } } },
  });
  const path = "/sessions/" + encodeURIComponent(session.id);
  let complete = false;
  try {
    onSession?.(session.id);
    const stream = await request(path + "/turns", signal, {
      method: "POST",
      stream: true,
      body: { stream: true, input: [{ type: "user.message", content: instruction }] },
    });
    for await (const event of events(stream)) {
      if (event.type === "model.message.delta" && event.thread_id === "main" && event.content) {
        output.append(event.content);
      }
      if (event.type === "turn.update" && event.state?.status === "paused") {
        throw new Error("TrueForge paused for input. Check the session for connector approval or configuration.");
      }
      if (event.type === "turn.done") {
        complete = true;
        output.appendLine("");
        if (event.state?.status === "done") return event.state.output?.content;
        throw new Error(event.state?.message || "TrueForge stopped before completing the request.");
      }
    }
    throw new Error("TrueForge closed the response before the turn completed.");
  } finally {
    if (!complete) {
      void request(path + "/cancel", AbortSignal.timeout(3000), { method: "POST" }).catch(() => {});
    }
  }
}

async function withGeneration(title, task) {
  return vscode.window.withProgress({
    title, location: vscode.ProgressLocation.Notification, cancellable: true,
  }, async (progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    const timeout = AbortSignal.timeout(150000);
    try {
      if (token.isCancellationRequested) return;
      return await task(AbortSignal.any([timeout, controller.signal]), progress);
    } catch (error) {
      if (token.isCancellationRequested) return;
      if (timeout.aborted) throw new Error("TrueForge did not finish within 150 seconds.");
      throw error;
    } finally {
      subscription.dispose();
    }
  });
}

module.exports = { request, runTurn, withGeneration };
