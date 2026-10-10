# dsh-shells

让 DeepSeek Harness 的 Agent 具备**多个跨平台持久后台 shell**：

- 模型面：官方 `@deepseek-ai/dsh-tool-terminal` 六工具（`terminal_open/send/read/signal/close/list`），本插件只做组合与扩展。
- POSIX：`bash`（官方 `dsh-terminal-bash`，backendType `shell`）+ `zsh`（本插件）。
- Windows：`cmd`、`gitbash`（自动发现 git-bash.exe）、`pwsh`（官方 dialect）。⚠️ Windows 后端在本机无法验证，实验性。
- GUI：侧边栏「后台 Shell」面板，只读跟随当前 agent 会话的 PTY 流（与模型所见一致，sanitizer 清洗后的纯文本）。

## 用法（Agent 侧）

```
terminal_open { "type": "zsh", "name": "watcher", "cwd": "/tmp" }
terminal_send { "id": "...", "stdin": "htop\n", "wait": "stdin_read" }
terminal_read { "id": "..." }
```

## 安装

```bash
# 从 GitHub
dsh plugin --profile <profile> add github:liu-zhengdong/dsh-shells

# 本地 checkout（开发用）
dsh plugin --profile <profile> add /abs/path/to/dsh-shells
```

无需构建：包直接发布 `src/` 下的 JS。

组合层（cordis.patch.yml）挂载：`dsh-terminal` + `dsh-terminal-bash` + `@deepseek-ai/dsh-tool-terminal` + `dsh-shells`。

## 实现要点

每个后端都是官方 `BashTerminalBackend` 的实例——PTY 会话机器（readiness、scrollback、sanitizer、read 分页）全部复用，只通过 `spawnTerminal` wrapper 改写 env：

| backendType | 机制 |
|---|---|
| `zsh` | `PS1 = "\x1b]133;D;\x07dsh> "`（raw ESC/BEL 经 env 透传；`-f` 跳过 rc 防覆盖） |
| `cmd` | `PROMPT` 环境变量注入同样 raw 标记 |
| `gitbash` | git-bash 即 bash，官方实例原样，只需发现 exe 路径 |
| `pwsh` | 官方 dialect（stdin 注入 prompt setup），路径找不到时注册 stub 后端给出清晰报错 |

侧边栏面板经 Remote 命名空间 `dshShellsPanel`（`list` / `attach` stream）按 `record.owner.session.id` 过滤当前会话的终端，300ms 轮询非破坏 `read()`。
