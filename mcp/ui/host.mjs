// O host falso do MCP App: fala com a tela só por postMessage, como o Claude faria (extensão io.modelcontextprotocol/ui) (#274).
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const HTML = readFileSync(new URL("./approval.html", import.meta.url), "utf8");
const DEADLINE = /const REQUEST_TIMEOUT_MS = \d+;/;

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function flush() {
  for (let i = 0; i < 10; i += 1) await tick();
}

/**
 * `routes`: nome da tool -> (arguments) => CallToolResult (ou promessa dele). Tool sem rota responde erro do host.
 * `unanswered`: métodos (ou `tools/call:<tool>`) que o host nunca responde (um host travado). `requestTimeoutMs`: encurta o prazo da tela
 * para o teste, trocando o valor da constante REQUEST_TIMEOUT_MS no HTML que o jsdom carrega, sem gancho no código. (#274)
 */
export function openScreen(routes = {}, { unanswered = [], requestTimeoutMs = null } = {}) {
  const sent = [];
  const calls = [];
  let dom = null;
  const reply = (id, payload) =>
    setTimeout(() => deliver({ jsonrpc: "2.0", id, ...payload }), 0);

  function receive(raw) {
    const message = JSON.parse(JSON.stringify(raw)); // sai do mundo do jsdom, como num postMessage de verdade (#274)
    sent.push(message);
    const toolKey = message.method === "tools/call" ? `tools/call:${message.params.name}` : message.method;
    if (unanswered.includes(message.method) || unanswered.includes(toolKey)) {
      if (message.method === "tools/call") calls.push({ name: message.params.name, arguments: message.params.arguments });
      return;
    }
    if (message.method === "ui/initialize") {
      reply(message.id, {
        result: { protocolVersion: "2026-01-26", hostInfo: { name: "host-falso", version: "0" }, hostCapabilities: {}, hostContext: {} },
      });
    } else if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      calls.push({ name, arguments: args });
      const route = routes[name];
      if (!route) return reply(message.id, { error: { code: -32601, message: "sem rota no host falso" } });
      Promise.resolve()
        .then(() => route(args))
        .then((result) => reply(message.id, { result }))
        .catch(() => reply(message.id, { error: { code: -32603, message: "falha do host" } }));
    }
  }

  function deliver(data, source = undefined) {
    const window = dom.window;
    window.dispatchEvent(new window.MessageEvent("message", { data, source: source === undefined ? window : source }));
  }

  const html = requestTimeoutMs === null ? HTML : HTML.replace(DEADLINE, `const REQUEST_TIMEOUT_MS = ${requestTimeoutMs};`);
  dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://host.exemplo/",
    beforeParse(window) {
      window.postMessage = receive; // a tela escreve em window.parent, que no jsdom é a própria janela (#274)
    },
  });
  const document = dom.window.document;

  const host = {
    sent,
    calls,
    document,
    window: dom.window,
    /** Os resultados de `name` já pedidos pela tela, só os argumentos. (#274) */
    callsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.arguments),
    /** O que o Claude faz ao chamar open_approval_app: manda o input e o resultado para a tela. (#274) */
    async openApp(structured = { view: "queue", invoice_access_key: null }) {
      await flush();
      deliver({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { view: structured.view } } });
      deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "Tela aberta." }], structuredContent: structured, isError: false },
      });
      await flush();
    },
    deliver,
    flush,
    $: (selector, root = document) => root.querySelector(selector),
    $$: (selector, root = document) => [...root.querySelectorAll(selector)],
    text: (element = document.body) => element.textContent.replace(/\s+/g, " ").trim(),
    click(element) {
      element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      return flush();
    },
    type(element, value) {
      element.value = value;
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      return flush();
    },
    choose(element, value) {
      element.value = value;
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      return flush();
    },
    check(element, checked = true) {
      element.checked = checked;
      element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      return flush();
    },
    close: () => dom.window.close(),
  };
  return host;
}
