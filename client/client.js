/**
 * dsh-shells client half —— 侧边栏「后台 Shell」面板：只读跟随当前 agent
 * 会话拥有的终端会话（dsh-shells 后端 + 官方 shell 后端开的都算）。
 *
 * apply 必须同步且不抛异常；Remote 命名空间惰性挂载（面板首渲染时 $mount）。
 */
window.__ModuleLoader__.load({
  id: "dsh-shells",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var name = "dsh-shells";
    var inject = ["slots", "remote", "sidebarRight", "sidebarRightTabs"];

    var NAMESPACE = "dshShellsPanel";
    var PACKAGE = "dsh-shells";

    // ---- Remote 描述符（与 src/panel-remote.js 对应）-----------------------
    function passthrough(field) {
      return {
        mode: "strict",
        typeSymbol: field,
        create: function () {
          return { parse: function (value) { return value; } };
        },
      };
    }
    function param(field) {
      return { name: field, wire: field, source: "json", codec: passthrough(field) };
    }
    var CONTRIBUTION = {
      package: PACKAGE,
      descriptors: [
        {
          id: PACKAGE + "#" + NAMESPACE + "/list",
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: "list",
          invocation: { kind: "direct" },
          parameters: [param("sessionId")],
          result: { mode: "src-json" },
        },
        {
          id: PACKAGE + "#" + NAMESPACE + "/attach",
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: "attach",
          invocation: { kind: "direct" },
          parameters: [param("sessionId"), param("terminalSessionId")],
          cancellation: { parameter: "signal" },
          mode: "stream",
          result: { mode: "src-json" },
        },
      ],
    };

    function unwrap(response) {
      if (response && response.ok === true) return response.value;
      var failure = response && response.error;
      if (!failure) throw new Error("Remote 调用没有返回结果");
      throw new Error(failure.code ? failure.code + "：" + failure.message : String(failure.message));
    }
    function namespace(ctx) {
      var api = ctx.get("remote." + NAMESPACE);
      if (api === undefined) throw new Error(NAMESPACE + " Remote 命名空间尚未挂载");
      return api;
    }

    // ---- 面板组件 ----------------------------------------------------------
    var S = {
      page: {
        display: "flex", flexDirection: "column", gap: "8px",
        padding: "12px", fontSize: "13px", height: "100%",
        color: "var(--dsw-alias-label-primary, inherit)",
      },
      header: { fontWeight: 600, fontSize: "14px" },
      hint: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: "12px" },
      list: { display: "flex", flexDirection: "column", gap: "4px" },
      item: {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "4px 8px", borderRadius: "6px", cursor: "pointer",
        border: "1px solid var(--dsw-alias-border-secondary, transparent)",
      },
      itemActive: {
        border: "1px solid var(--dsw-alias-border-accent, #4a9eff)",
        background: "var(--dsw-alias-fill-secondary, rgba(255,255,255,.06))",
      },
      itemTitle: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      output: {
        flex: "1", margin: "0", padding: "8px",
        fontFamily: "var(--dsw-alias-font-family-mono, ui-monospace, monospace)",
        fontSize: "12px", lineHeight: "1.4", whiteSpace: "pre-wrap", wordBreak: "break-all",
        overflow: "auto", background: "var(--dsw-alias-fill-secondary, rgba(255,255,255,.04))",
        borderRadius: "6px", minHeight: "120px",
      },
    };

    function ShellsBody(props) {
      var ctx = props.ctx;
      var sessionId = props.sessionId;
      var selectedId = useRef(null);
      var sessionsState = useState([]);
      var errorState = useState("");

      // 1) 拉会话列表
      useEffect(function () {
        var cancelled = false;
        var api;
        try {
          api = namespace(ctx);
        } catch (e) {
          errorState[1](String(e && e.message || e));
          return;
        }
        var tick = function () {
          api.list(sessionId)
            .then(unwrap)
            .then(function (list) {
              if (cancelled) return;
              sessionsState[1](list || []);
              if (list && list.length && !selectedId.current) selectedId.current = list[0].id;
            })
            .catch(function () {});
        };
        tick();
        var timer = setInterval(tick, 2000);
        return function () {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      var selected = null;
      var list = sessionsState[0] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === selectedId.current) selected = list[i];
      }

      var bodyInner = null;
      if (errorState[0]) {
        bodyInner = createElement("div", { style: S.hint }, errorState[0]);
      } else if (!list.length) {
        bodyInner = createElement(
          "div",
          { style: S.hint },
          "当前会话还没有后台 shell。让 Agent 用 terminal_open 开一个（type: shell / zsh / cmd / gitbash / pwsh）。",
        );
      } else {
        var items = list.map(function (s) {
          return createElement(
            "div",
            {
              key: s.id,
              style: Object.assign(
                {},
                S.item,
                s.id === selectedId.current ? S.itemActive : null,
              ),
              onClick: function () {
                selectedId.current = s.id;
                sessionsState[1](list.slice());
              },
            },
            createElement("span", { style: S.itemTitle },
              (s.type || "?") + (s.name ? " · " + s.name : "") + " · " + (s.status || "?")),
          );
        });
        bodyInner = createElement("div", { style: S.page },
          createElement("div", { style: S.list }, items),
          createElement(AttachStream, {
            ctx: ctx, sessionId: sessionId,
            terminalSessionId: selected ? selected.id : null,
          }),
        );
      }
      return createElement("div", { style: S.page }, bodyInner);
    }

    /** 只读输出流：<pre> 渲染 sanitizer 清洗后的纯文本。 */
    function AttachStream(props) {
      var ctx = props.ctx;
      var textState = useState("");
      var statusState = useState("");
      var errorState = useState("");
      var terminalSessionId = props.terminalSessionId;

      useEffect(function () {
        if (!terminalSessionId) return undefined;
        textState[1]("");
        statusState[1]("");
        errorState[1]("");
        var api;
        try {
          api = namespace(ctx);
        } catch (e) {
          errorState[1](String(e && e.message || e));
          return undefined;
        }
        var controller = new AbortController();
        var cancelled = false;
        var pending = api.attach(props.sessionId, terminalSessionId, controller.signal);
        pending
          .then(function (handle) {
            return (async function () {
              for await (var frame of handle) {
                if (cancelled) return;
                if (frame.type === "output" || frame.type === "reset") {
                  textState[1](function (prev) {
                    var next = frame.type === "reset" ? (frame.text || "") : prev + (frame.text || "");
                    // 粗截断：面板只保留尾部 ~64KB，防止长会话撑爆 DOM
                    if (next.length > 65536) next = next.slice(-65536);
                    return next;
                  });
                } else if (frame.type === "status") {
                  statusState[1](String(frame.status));
                } else if (frame.type === "closed") {
                  statusState[1]("closed");
                  return;
                }
              }
            })();
          })
          .catch(function (e) {
            if (!cancelled) errorState[1](String(e && e.message || e));
          });
        return function () {
          cancelled = true;
          controller.abort();
        };
      }, [terminalSessionId]);

      if (!terminalSessionId) return null;
      return createElement("div", { style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } },
        errorState[0]
          ? createElement("div", { style: S.hint }, errorState[0])
          : createElement("pre", { style: S.output },
              textState[0] || (statusState[0] ? "" : "（等待输出…）")),
      );
    }

    // ---- apply：注册侧边栏 tab --------------------------------------------
    function apply(ctx) {
      var mounting = null;
      function mount() {
        if (mounting === null) {
          mounting = Promise.resolve()
            .then(function () { return ctx.remote.$mount(CONTRIBUTION); })
            .then(
              function () { return null; },
              function (error) {
                console.error("dsh-shells: 挂载 Remote 命名空间失败", error);
                return String(error && error.message || error);
              },
            );
        }
        return mounting;
      }

      // tab kind + 面板槽位（抄官方 sidebar-terminal 的两阶段注册形态）
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: PACKAGE,
          kind: "shells",
          multiple: false,
          priority: "extension",
          title: function () { return "后台 Shell"; },
          guide: [{
            id: "shells",
            order: 50,
            title: function () { return "后台 Shell"; },
            description: function () { return "只读查看 Agent 开的持久 shell 会话（bash/zsh/cmd/gitbash/pwsh）"; },
          }],
        });
      }, "dsh-shells.tabs");

      return ctx.slots.inject("sidebar.right.pane.tab", function () {
        return ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: PACKAGE,
          inject: function (sessionId) {
            void mount(); // 惰性挂载：首次有面板渲染前触发
            return { ctx: ctx, sessionId: sessionId };
          },
        }, function ShellsTabWrapper(tabProps) {
          // 官方 Body 用 useTabInfo() 拿 tab；这里 slot inject 回调返回的
          // props（含 sessionId）由宿主合并进 tabProps。
          return createElement(ShellsBody, {
            ctx: tabProps.ctx || ctx,
            sessionId: tabProps.sessionId,
          });
        });
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
