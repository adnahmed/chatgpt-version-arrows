(function () {
  "use strict";

  const VERSION = "0.8.0-batch-test.1";
  const SHELL_ATTRIBUTE = "data-codex-window-type";
  const USER_BUBBLE = "[data-user-message-bubble]";
  const CONTROLS = "[data-batch-edit-pagination]";
  const BATCH_PATH = "/backend-api/conversations/batch";
  const RUNTIME_HINT = /^\/cdn\/assets\/633146\.[a-z0-9]+\.js$/;
  const MAX_GRAPHS = 3;
  const MAX_EVENTS = 500;
  const graphs = new Map();
  const pendingConversations = new Set();
  const conversationErrors = new Map();
  const attemptedRuntimeUrls = new Set();
  const warned = new Set();
  const diagnostics = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    batchRequests: 0,
    batchCaptures: 0,
    renders: 0,
    contextScans: 0,
    runtimeImports: 0,
    runtimeImportFailures: 0,
    switcherScans: 0,
    switcher: null,
    events: [],
  };
  let latestBatchPayload = null;
  let runtime = null;
  let runtimeCleanup = null;
  let switcher = null;
  let runtimeDiscovery = null;
  let frame = null;
  let observer = null;
  let rootObserver = null;
  let stopped = false;
  let pass = 0;

  const record = (type, details = {}) => {
    diagnostics.events.push({ at: new Date().toISOString(), type, ...details });
    if (diagnostics.events.length > MAX_EVENTS) diagnostics.events.splice(0, diagnostics.events.length - MAX_EVENTS);
  };

  const warnOnce = (key, message, details = {}) => {
    if (warned.has(key)) return;
    warned.add(key);
    const build = document.documentElement?.getAttribute("data-build") ?? "unknown";
    console.warn(`[Edit Pagination][batch] ${message} (build ${build})`, details);
    record("warning", { key, message, build, ...details });
  };

  const isShell = () => document.documentElement?.hasAttribute(SHELL_ATTRIBUTE) === true;

  const requestDetails = (input, init) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
    const rawUrl = request?.url ?? (input instanceof URL ? input.href : String(input ?? ""));
    try {
      return { method, url: new URL(rawUrl, location.href) };
    } catch {
      return { method, url: null };
    }
  };

  const isBatchRequest = (input, init) => {
    const { method, url } = requestDetails(input, init);
    return method === "POST" && url?.origin === location.origin && url.pathname === BATCH_PATH;
  };

  const compactGraph = (payload) => {
    if (!payload || typeof payload !== "object" || !payload.mapping || typeof payload.mapping !== "object") {
      return null;
    }
    const conversationId = String(payload.conversation_id ?? payload.id ?? "");
    if (!conversationId) return null;
    const mapping = {};
    for (const [id, node] of Object.entries(payload.mapping)) {
      if (!node || typeof node !== "object") continue;
      mapping[id] = {
        parent: typeof node.parent === "string" ? node.parent : null,
        children: Array.isArray(node.children)
          ? node.children.filter((childId) => typeof childId === "string")
          : [],
        role: typeof node.message?.author?.role === "string" ? node.message.author.role : null,
      };
    }
    return {
      conversationId,
      currentNode: typeof payload.current_node === "string" ? payload.current_node : null,
      mapping,
    };
  };

  const graphSummary = (graph) => {
    let userVariantGroups = 0;
    let assistantVariantGroups = 0;
    let maxUserVariants = 0;
    for (const node of Object.values(graph.mapping)) {
      if (!Array.isArray(node.children)) continue;
      const userChildren = node.children.filter((id) => graph.mapping[id]?.role === "user").length;
      const assistantChildren = node.children.filter((id) => graph.mapping[id]?.role === "assistant").length;
      if (userChildren > 1) {
        userVariantGroups++;
        maxUserVariants = Math.max(maxUserVariants, userChildren);
      }
      if (assistantChildren > 1) assistantVariantGroups++;
    }
    return {
      conversationId: graph.conversationId,
      currentNode: graph.currentNode,
      mappingCount: Object.keys(graph.mapping).length,
      userVariantGroups,
      assistantVariantGroups,
      maxUserVariants,
    };
  };

  const storeGraph = (graph) => {
    graphs.delete(graph.conversationId);
    graphs.set(graph.conversationId, graph);
    while (graphs.size > MAX_GRAPHS) graphs.delete(graphs.keys().next().value);
  };

  const captureBatch = (payload, url) => {
    const conversations = Array.isArray(payload) ? payload : [];
    const captured = [];
    latestBatchPayload = payload;
    for (const conversation of conversations) {
      const graph = compactGraph(conversation);
      if (!graph) continue;
      storeGraph(graph);
      captured.push(graphSummary(graph));
    }
    diagnostics.batchCaptures++;
    record("batch-captured", { url, conversationCount: conversations.length, graphs: captured });
    if (!captured.length) warnOnce("batch-shape", "The batch response did not contain a usable conversation graph.");
    schedule();
    return captured.length;
  };

  const installBatchObserver = () => {
    if (typeof window.fetch !== "function") return;
    const originalFetch = window.fetch;
    window.fetch = function observedFetch(input, init) {
      const batch = isBatchRequest(input, init);
      const responsePromise = Reflect.apply(originalFetch, this, arguments);
      if (!batch) return responsePromise;
      diagnostics.batchRequests++;
      const { url } = requestDetails(input, init);
      record("batch-request", { url: url?.href ?? String(input ?? "") });
      void responsePromise.then((response) => {
        if (!response.ok) {
          warnOnce("batch-http", `The batch request returned HTTP ${response.status}.`, { status: response.status });
          return;
        }
        return response.clone().json().then(
          (payload) => captureBatch(payload, response.url),
          (error) => warnOnce("batch-json", "The batch response could not be parsed.", { error: String(error) }),
        );
      }, (error) => warnOnce("batch-fetch", "The batch request failed.", { error: String(error) }));
      return responsePromise;
    };
  };

  const getFiber = (element) => Object.getOwnPropertyNames(element)
    .find((name) => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));

  const isScope = (value) => value && typeof value === "object" &&
    value.scope?.__scopeBrand === "AppScope" && typeof value.get === "function";

  const scopeInHooks = (hook) => {
    for (let index = 0; hook && index < 150; index++, hook = hook.next) {
      if (isScope(hook.memoizedState)) return hook.memoizedState;
      if (isScope(hook.memoizedState?.current)) return hook.memoizedState.current;
    }
    return null;
  };

  const readContext = (bubble) => {
    diagnostics.contextScans++;
    const key = getFiber(bubble);
    let fiber = key ? bubble[key] : null;
    let scope = null;
    const candidates = [];
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      for (const current of [fiber, fiber.alternate]) {
        if (!current) continue;
        scope ??= scopeInHooks(current.memoizedState);
        const props = current.memoizedProps;
        if (!props || typeof props !== "object") continue;
        if (props.item?.type === "user-message" && typeof props.item.messageId === "string" &&
            typeof props.conversationId === "string") {
          candidates.push({ conversationId: props.conversationId, messageId: props.item.messageId });
        }
      }
    }
    if (!scope || !candidates.length) return null;
    const unique = [...new Map(candidates.map((item) => [`${item.conversationId}:${item.messageId}`, item])).values()];
    const matching = unique.find((item) => graphs.get(item.conversationId)?.mapping[item.messageId]) ??
      unique.find((item) => [...graphs.values()].some((graph) => graph.mapping[item.messageId]));
    return matching ? { ...matching, scope } : { ...unique[0], scope };
  };

  const graphFor = (context) => graphs.get(context.conversationId) ??
    [...graphs.values()].find((graph) => graph.mapping[context.messageId]) ?? null;

  const variants = (graph, messageId, role = "user") => {
    const node = graph?.mapping?.[messageId];
    if (!node || node.role !== role || !node.parent) return [];
    const children = graph.mapping[node.parent]?.children;
    if (!Array.isArray(children)) return [];
    return [...new Set(children)].filter((id) => graph.mapping[id]?.parent === node.parent && graph.mapping[id]?.role === role);
  };

  const findMount = (bubble) => {
    let element = bubble.parentElement;
    for (let depth = 0; element && depth < 9; depth++, element = element.parentElement) {
      if (element.querySelectorAll(USER_BUBBLE).length !== 1) continue;
      const rows = element.querySelectorAll(".turn-action-controls");
      if (rows.length === 1) return { mount: rows[0].parentElement, row: rows[0] };
    }
    return null;
  };

  const labels = () => document.documentElement.lang.toLowerCase().startsWith("ru")
    ? {
      previous: "Предыдущая версия",
      next: "Следующая версия",
      group: "Версии сообщения",
      failed: "Не удалось переключить версию сообщения.",
    }
    : {
      previous: "Previous version",
      next: "Next version",
      group: "Message versions",
      failed: "Could not switch the message version.",
    };

  const createButton = (label, direction, action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", direction < 0 ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    button.append(svg);
    button.addEventListener("click", action);
    return button;
  };

  const switchVersion = async (bubble, direction) => {
    const context = readContext(bubble);
    if (!context || pendingConversations.has(context.conversationId)) return;
    const graph = graphFor(context);
    const ids = variants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const target = index < 0 ? null : ids[index + direction];
    if (!target) return;
    if (!switcher) {
      await discoverRuntime();
      scanSwitcher();
    }
    if (!switcher) {
      warnOnce("switcher-missing", "The native branch switcher is not available.");
      return;
    }
    pendingConversations.add(context.conversationId);
    conversationErrors.delete(context.conversationId);
    record("switch-requested", {
      conversationId: context.conversationId,
      currentMessageId: context.messageId,
      targetMessageId: target,
    });
    schedule();
    try {
      await switcher(context.scope, context.conversationId, target);
      record("switch-completed", { conversationId: context.conversationId, targetMessageId: target });
    } catch (error) {
      const message = labels().failed;
      conversationErrors.set(context.conversationId, message);
      record("switch-failed", { conversationId: context.conversationId, targetMessageId: target, error: String(error) });
      warnOnce("switch-failed", message, { error: String(error) });
    } finally {
      pendingConversations.delete(context.conversationId);
      schedule();
    }
  };

  const paint = (bubble, context, graph, mountInfo, currentPass) => {
    const ids = variants(graph, context.messageId);
    const index = ids.indexOf(context.messageId);
    const { mount } = mountInfo;
    let controls = mount.querySelector(CONTROLS);
    if (ids.length < 2 || index < 0) {
      controls?.remove();
      return false;
    }
    if (!controls) {
      const text = labels();
      controls = document.createElement("span");
      controls.setAttribute("data-batch-edit-pagination", "");
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", text.group);
      const previous = createButton(text.previous, -1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(bubble, -1);
      });
      const counter = document.createElement("span");
      counter.setAttribute("aria-live", "polite");
      counter.setAttribute("aria-atomic", "true");
      const next = createButton(text.next, 1, (event) => {
        event.preventDefault();
        event.stopPropagation();
        void switchVersion(bubble, 1);
      });
      controls.append(previous, counter, next);
    }
    controls.dataset.pass = String(currentPass);
    controls.dataset.conversationId = context.conversationId;
    controls.dataset.messageId = context.messageId;
    if (controls.parentElement !== mount) mount.append(controls);
    const [previous, counter, next] = controls.children;
    const caption = `${index + 1}/${ids.length}`;
    counter.textContent = caption;
    const busy = pendingConversations.has(context.conversationId);
    previous.disabled = busy || index === 0;
    next.disabled = busy || index === ids.length - 1;
    controls.setAttribute("aria-busy", String(busy));
    const error = conversationErrors.get(context.conversationId) ?? "";
    controls.title = error;
    counter.setAttribute("aria-label", error ? `${caption}. ${error}` : caption);
    return true;
  };

  const suppressNativeVersions = (mountInfo) => {
    for (const button of mountInfo.row.querySelectorAll('button[aria-label="See versions"]')) {
      if (!button.hasAttribute("data-batch-pagination-suppressed")) {
        button.setAttribute("data-batch-pagination-suppressed", "");
        record("native-versions-suppressed");
      }
    }
  };

  const candidateSource = (value) => {
    try {
      return Function.prototype.toString.call(value);
    } catch {
      return "";
    }
  };

  const scanSwitcher = () => {
    if (switcher || !runtime?.c) return switcher;
    diagnostics.switcherScans++;
    const hits = [];
    for (const [moduleId, module] of Object.entries(runtime.c)) {
      const exports = module?.exports;
      if (!exports || (typeof exports !== "object" && typeof exports !== "function")) continue;
      let keys;
      try {
        keys = Object.keys(exports);
      } catch {
        continue;
      }
      for (const exportName of keys) {
        let candidate;
        try {
          candidate = exports[exportName];
        } catch {
          continue;
        }
        if (typeof candidate !== "function") continue;
        const source = candidateSource(candidate);
        if (source.includes("current_node_id") && source.includes("/conversation/{conversation_id}")) {
          hits.push({ moduleId, exportName, candidate });
        }
      }
    }
    if (hits.length === 1) {
      switcher = hits[0].candidate;
      diagnostics.switcher = { moduleId: hits[0].moduleId, exportName: hits[0].exportName };
      record("switcher-found", diagnostics.switcher);
      schedule();
    } else if (hits.length > 1) {
      warnOnce("switcher-ambiguous", "More than one native branch switcher matched the required behavior.", {
        candidates: hits.map(({ moduleId, exportName }) => ({ moduleId, exportName })),
      });
    }
    return switcher;
  };

  const attachRuntime = (candidate) => {
    if (runtime || !candidate?.c || !candidate?.m) return false;
    runtime = candidate;
    record("runtime-found", { cacheSize: Object.keys(runtime.c).length });
    scanSwitcher();
    if (typeof runtime.C === "function") {
      const originalRegister = runtime.C;
      const register = function (...args) {
        const result = Reflect.apply(originalRegister, this, args);
        queueMicrotask(() => {
          scanSwitcher();
          schedule();
        });
        return result;
      };
      runtime.C = register;
      runtimeCleanup = () => {
        if (runtime?.C === register) runtime.C = originalRegister;
      };
    }
    return true;
  };

  async function discoverRuntime() {
    if (runtime || stopped) return runtime;
    if (runtimeDiscovery) return runtimeDiscovery;
    runtimeDiscovery = (async () => {
      const urls = [...document.querySelectorAll('link[rel="modulepreload"][href]')]
        .map((link) => {
          try {
            return new URL(link.href, location.href);
          } catch {
            return null;
          }
        })
        .filter((url) => url?.origin === location.origin && url.pathname.endsWith(".js"));
      urls.sort((a, b) => Number(RUNTIME_HINT.test(b.pathname)) - Number(RUNTIME_HINT.test(a.pathname)));
      for (const url of urls) {
        if (attemptedRuntimeUrls.has(url.href)) continue;
        attemptedRuntimeUrls.add(url.href);
        diagnostics.runtimeImports++;
        try {
          const module = await import(url.href);
          if (attachRuntime(module.__webpack_require__)) break;
        } catch (error) {
          diagnostics.runtimeImportFailures++;
          record("runtime-import-failed", { url: url.href, error: String(error) });
        }
      }
      return runtime;
    })().finally(() => {
      runtimeDiscovery = null;
    });
    return runtimeDiscovery;
  }

  const reconcile = () => {
    frame = null;
    if (stopped) return;
    diagnostics.renders++;
    const currentPass = ++pass;
    if (!isShell()) {
      for (const controls of document.querySelectorAll(CONTROLS)) controls.remove();
      return;
    }
    const bubbles = [...document.querySelectorAll(USER_BUBBLE)];
    let painted = 0;
    for (const bubble of bubbles) {
      const mountInfo = findMount(bubble);
      if (!mountInfo) continue;
      suppressNativeVersions(mountInfo);
      const context = readContext(bubble);
      if (!context) continue;
      const graph = graphFor(context);
      if (!graph) continue;
      if (paint(bubble, context, graph, mountInfo, currentPass)) painted++;
    }
    for (const controls of document.querySelectorAll(CONTROLS)) {
      if (controls.dataset.pass !== String(currentPass)) controls.remove();
    }
    record("render", { bubbleCount: bubbles.length, painted, graphCount: graphs.size });
    if (bubbles.length && graphs.size && !runtime) void discoverRuntime();
    else if (runtime && !switcher) scanSwitcher();
  };

  function schedule() {
    if (stopped || frame !== null || typeof requestAnimationFrame !== "function") return;
    frame = requestAnimationFrame(reconcile);
  }

  const mutationMatters = (mutation) => {
    if (mutation.type === "attributes") return true;
    const relevant = (node) => node.nodeType === 1 &&
      (node.matches?.(USER_BUBBLE) || node.querySelector?.(USER_BUBBLE) ||
       node.matches?.(".turn-action-controls") || node.querySelector?.(".turn-action-controls") ||
       node.matches?.('link[rel="modulepreload"]'));
    return [...mutation.addedNodes, ...mutation.removedNodes].some(relevant);
  };

  const observe = () => {
    const root = document.documentElement;
    if (!root || observer) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.some(mutationMatters)) schedule();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [SHELL_ATTRIBUTE, "data-user-message-bubble"],
    });
    schedule();
  };

  const debugSnapshot = () => ({
    version: VERSION,
    capturedAt: new Date().toISOString(),
    location: { origin: location.origin, pathname: location.pathname },
    document: {
      build: document.documentElement?.getAttribute("data-build") ?? null,
      shell: isShell(),
      lang: document.documentElement?.lang ?? "",
      readyState: document.readyState,
    },
    diagnostics: {
      ...diagnostics,
      events: diagnostics.events.slice(),
    },
    graphs: [...graphs.values()].map((graph) => ({ ...graph, summary: graphSummary(graph) })),
    latestBatchPayload,
    controls: [...document.querySelectorAll(CONTROLS)].map((controls) => ({
      conversationId: controls.dataset.conversationId ?? null,
      messageId: controls.dataset.messageId ?? null,
      caption: controls.textContent,
    })),
  });

  const downloadDebugSnapshot = () => {
    const blob = new Blob([JSON.stringify(debugSnapshot(), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `chatgpt-edit-pagination-batch-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  installBatchObserver();
  if (document.documentElement) observe();
  else {
    rootObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      rootObserver.disconnect();
      rootObserver = null;
      observe();
    });
    rootObserver.observe(document, { childList: true });
  }
  addEventListener("pageshow", schedule);
  addEventListener("popstate", schedule);
  addEventListener("load", () => {
    schedule();
    if (isShell() && graphs.size && !runtime) void discoverRuntime().then((value) => {
      if (!value) warnOnce("runtime-missing", "The webpack runtime could not be discovered from loaded module preloads.");
    });
  }, { once: true });
  addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer?.disconnect();
    rootObserver?.disconnect();
    runtimeCleanup?.();
  }, { once: true });

  globalThis.__chatgptBatchPagination = {
    version: VERSION,
    getDebugSnapshot: debugSnapshot,
    downloadDebugSnapshot,
  };

  if (globalThis.__CHATGPT_EDIT_PAGINATION_PATCH_TEST__ === true) {
    globalThis.__chatgptBatchPaginationTest = {
      attachRuntime,
      captureBatch,
      compactGraph,
      graphFor,
      graphSummary,
      isBatchRequest,
      readContext,
      scanSwitcher,
      variants,
    };
  }
})();
