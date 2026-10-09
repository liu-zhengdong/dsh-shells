/**
 * dshShellsPanel Remote 命名空间：把 ctx.terminals 里属于某个会话的
 * PTY 会话以只读流的形式喂给 Web 侧边栏面板。
 *
 * 方法：
 * - list(sessionId) → [{id, name, type, status, pid}]
 * - attach(sessionId, terminalSessionId, signal) → async generator
 *   帧：{type:"output",text,truncated?} | {type:"status",status}
 *       | {type:"reset",text} | {type:"closed"}
 *
 * 插件解析不到 asar 内部的 @deepseek-ai/dsh-typert-protocol，所以
 * TypertRemoteService 的两件事手工复刻（抄 dsh-hosted-tools 的 auth-remote）：
 * 1) 实例上挂 typertRemote 绑定 {service, serviceKey, namespace}；
 * 2) 原型上挂 REMOTE_METHOD_DESCRIPTOR（version:1 methods 标记）。
 * SRC fallback 用 Function.prototype.toString 解析参数名：方法必须是普通类
 * 方法、参数为简单标识符；末位参数名为 signal 即取消信号。
 */

const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

export const PANEL_SERVICE_KEY = "dsh-shells/panel";
export const PANEL_NAMESPACE = "dshShellsPanel";

const POLL_INTERVAL_MS = 300;

class ShellsPanelService {
  constructor(ctx) {
    this.ctx = ctx;
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: PANEL_SERVICE_KEY,
      namespace: PANEL_NAMESPACE,
    });
  }

  /** 枚举该 agent 会话拥有的终端会话（owner.session.id 优先，owner.id 兜底）。 */
  #recordsFor(sessionId) {
    const sessions = this.ctx.terminals.sessions;
    if (!sessions || typeof sessions.values !== "function") return [];
    const records = [];
    for (const record of sessions.values()) {
      const owner = record?.owner;
      const ownerSessionId = owner?.session?.id ?? owner?.id;
      if (ownerSessionId === sessionId) records.push(record);
    }
    return records;
  }

  async list(sessionId) {
    return this.#recordsFor(sessionId).map((record) => ({
      id: record.sessionId,
      name: record.name ?? null,
      type: record.type ?? null,
      status: (() => {
        try {
          return record.session?.status?.() ?? "unknown";
        } catch {
          return "unknown";
        }
      })(),
      pid: record.session?.pid ?? null,
    }));
  }

  /**
   * 只读跟随一个终端会话的 scrollback + 增量输出。
   * read() 非破坏；sanitizer 已把 OSC 等控制序列清洗成纯文本，客户端直接渲染。
   */
  async *attach(sessionId, terminalSessionId, signal) {
    const records = this.#recordsFor(sessionId);
    const record = records.find((r) => r.sessionId === terminalSessionId);
    if (!record) {
      throw new Error(`terminal session ${terminalSessionId} not found for this conversation`);
    }
    const session = record.session;
    let linesSeen = 0;
    let closedSent = false;

    while (!closedSent) {
      if (signal?.aborted) return;
      let snapshot;
      let totalLines;
      try {
        snapshot = session.read();
        totalLines = snapshot.lines?.length ?? 0;
      } catch (error) {
        closedSent = true;
        yield { type: "closed", reason: String(error?.message ?? error) };
        break;
      }
      if (totalLines < linesSeen) {
        // scrollback 截断：整屏重发
        linesSeen = 0;
        yield { type: "reset", text: snapshot.text ?? snapshot.lines?.join("") ?? "" };
        linesSeen = totalLines;
      } else if (totalLines > linesSeen) {
        const fresh = snapshot.lines.slice(linesSeen);
        linesSeen = totalLines;
        yield { type: "output", text: fresh.join(""), truncated: snapshot.truncated ?? false };
      }
      let status;
      try {
        status = session.status?.() ?? "unknown";
      } catch {
        status = "unknown";
      }
      yield { type: "status", status };
      if (status === "exited" || status === "closed") {
        closedSent = true;
        yield { type: "closed", reason: status };
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}

/** 往类原型上写 remote-methods 描述符（等价 @Remote / @Remote({mode:"stream"})）。 */
function markRemote(prototype, entries) {
  const methods = entries.map(({ method, mode }) =>
    Object.freeze({
      method,
      ...(mode === undefined ? {} : { mode }),
      invocation: Object.freeze({ kind: "direct" }),
    }),
  );
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(methods) }),
  });
}

markRemote(ShellsPanelService.prototype, [
  { method: "list" },
  { method: "attach", mode: "stream" },
]);

export function registerPanelRemote(ctx) {
  ctx.provide(PANEL_SERVICE_KEY, new ShellsPanelService(ctx));
}
