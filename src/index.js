/**
 * dsh-shells —— 注册额外的持久 shell 后端，让 Agent 的 terminal_open 能开
 * zsh / cmd / gitbash / pwsh 会话（bash 由官方 dsh-terminal-bash 提供，
 * backendType 默认 "shell"）。
 *
 * 每个后端都是官方 BashTerminalBackend 的一个实例：官方的 PTY 会话机器
 * （readiness、scrollback、sanitizer、read 分页）全部复用，我们只通过
 * spawnTerminal wrapper 改写启动 spec（argv/env），注入各 shell 的
 * 就绪标记（OSC 133;D; + "dsh> " 提示符尾）。
 *
 * Windows 后端（cmd/gitbash/pwsh）在 macOS 上无法验证，实验性。
 */

import z from "@deepseek-ai/schemastery";
import { existsSync } from "node:fs";
import { BashTerminalBackend, Config as backendConfig } from "@deepseek-ai/dsh-terminal-bash";
import { registerPanelRemote } from "./panel-remote.js";

export const name = "dsh-shells";

export const inject = ["terminals", "sandboxPolicy", "sessionProjections", "subprocess"];

/** OSC 133;D; + BEL + 官方受控提示符尾，随 env 原样透传（raw 字节）。 */
const READY_MARKER = "\x1b]133;D;\x07dsh> ";

export const Config = z.object({
  zshPath: z.string().default("/bin/zsh").description("zsh 可执行文件路径"),
  zshArgs: z.array(z.string()).default(["-f", "-i"]).description("zsh 启动参数（-f 跳过 rc，防止 PS1 被覆盖）"),
  cmdPath: z.string().default("cmd.exe").description("Windows cmd 可执行文件"),
  cmdArgs: z.array(z.string()).default([]).description("cmd 启动参数"),
  gitBashPath: z.string().default("").description("git-bash.exe 路径；留空自动发现"),
  pwshPath: z.string().default("").description("pwsh 可执行文件；留空走官方 resolvePwshPath()"),
  rows: z.number().default(40),
  cols: z.number().default(160),
  scrollbackLines: z.number().default(1e4),
  scrollbackMaxBytes: z.number().default(4 * 1024 * 1024),
  maxReadBytes: z.number().default(256 * 1024),
  pollIntervalMs: z.number().default(50),
  exactProbeAfterMs: z.number().default(150),
  idleSilenceMs: z.number().default(3000),
  timeoutMs: z.number().default(30000),
});

function log(text) {
  process.stderr.write(`dsh-shells: ${text}\n`);
}

/** 通用 shell 数值配置（从我们的 Config 提取官方 session 参数）。 */
function sessionConfig(config, extra) {
  // 官方 Config 带一批本插件不暴露的 grace 字段（disposeGraceMs 等）。官方 apply()
  // 会先过一遍 Config 补默认值，我们直接 new BashTerminalBackend 不会，所以这里自己补：
  // disposeGraceMs 缺失会让 PTY 清理的宽限期变成 NaN，close() 直接抛
  // "PTY cleanup failed"；handoffGraceMs 缺失会让就绪判定永远不按 idle 收敛。
  return backendConfig({
    rows: config.rows,
    cols: config.cols,
    scrollbackLines: config.scrollbackLines,
    scrollbackMaxBytes: config.scrollbackMaxBytes,
    maxReadBytes: config.maxReadBytes,
    pollIntervalMs: config.pollIntervalMs,
    exactProbeAfterMs: config.exactProbeAfterMs,
    idleSilenceMs: config.idleSilenceMs,
    timeoutMs: config.timeoutMs,
    ...extra,
  });
}

/**
 * 包一层 spawnTerminal：在 spec 交给 ctx.subprocess.spawnTerminal 前改写 env。
 * wrapper 返回值必须还是 spec（argv/cwd/env/rows/cols/terminalType/signal）。
 */
function wrapEnv(spawnTerminal, patch) {
  return (spec) => spawnTerminal({ ...spec, env: { ...spec.env, ...patch(spec.env ?? {}) } });
}

export function apply(ctx, config) {
  /** stub 后端：shell 不存在时仍注册 backendType，spawn 时给出清晰错误。 */
  const stubBackend = (type, message) => ({
    type,
    async spawn(request) {
      throw new Error(`${type} backend unavailable: ${message}`);
    },
  });

  /** zsh：官方 bash dialect 的会话机器 + raw-ESC PS1。 */
  try {
    const zshBackend = new BashTerminalBackend(
      ctx,
      sessionConfig(config, {
        backendType: "zsh",
        shellDialect: "bash",
        shellPath: config.zshPath,
        shellArgs: config.zshArgs,
      }),
      wrapEnv(ctx.subprocess.spawnTerminal.bind(ctx.subprocess), () => ({
        PS1: READY_MARKER,
      })),
    );
    ctx.terminals.registerBackend(zshBackend);
  } catch (error) {
    log(`zsh backend unavailable: ${error?.message ?? error}`);
  }

  /** pwsh：官方 dialect，stdin 注入 setup 全部官方逻辑。非 Windows 或无 pwsh 时挂 stub。 */
  if (config.pwshPath === "" && process.platform !== "win32") {
    // 官方 spawnArgv 走 resolvePwshPath()，在 macOS 上会抛错；直接 stub。
    ctx.terminals.registerBackend(stubBackend("pwsh", "pwsh backend is Windows-only on this host; install PowerShell and set dsh-shells pwshPath to enable"));
  } else {
    try {
      const pwshBackend = new BashTerminalBackend(
        ctx,
        sessionConfig(config, {
          backendType: "pwsh",
          shellDialect: "pwsh",
          ...(config.pwshPath ? { shellPath: config.pwshPath, shellArgs: [] } : {}),
        }),
      );
      ctx.terminals.registerBackend(pwshBackend);
    } catch (error) {
      ctx.terminals.registerBackend(stubBackend("pwsh", String(error?.message ?? error)));
      log(`pwsh backend stub: ${error?.message ?? error}`);
    }
  }

  /** cmd：PROMPT 环境变量注入 raw 标记（cmd 用 PROMPT 渲染提示符）。仅 Windows。 */
  if (process.platform !== "win32") {
    ctx.terminals.registerBackend(stubBackend("cmd", "cmd backend is Windows-only on this host"));
  } else {
    try {
      const cmdBackend = new BashTerminalBackend(
        ctx,
        sessionConfig(config, {
          backendType: "cmd",
          shellDialect: "bash",
          shellPath: config.cmdPath,
          shellArgs: config.cmdArgs,
        }),
        wrapEnv(ctx.subprocess.spawnTerminal.bind(ctx.subprocess), () => ({
          PROMPT: READY_MARKER,
        })),
      );
      ctx.terminals.registerBackend(cmdBackend);
    } catch (error) {
      ctx.terminals.registerBackend(stubBackend("cmd", String(error?.message ?? error)));
      log(`cmd backend stub: ${error?.message ?? error}`);
    }
  }

  /** gitbash：git-bash 就是 bash，官方实例原样（只需找到 exe）。 */
  const gitBash = config.gitBashPath || findGitBash();
  if (gitBash) {
    try {
      const gitbashBackend = new BashTerminalBackend(
        ctx,
        sessionConfig(config, {
          backendType: "gitbash",
          shellDialect: "bash",
          shellPath: gitBash,
          shellArgs: ["--noprofile", "--norc", "-i"],
        }),
      );
      ctx.terminals.registerBackend(gitbashBackend);
    } catch (error) {
      log(`gitbash backend unavailable: ${error?.message ?? error}`);
    }
  } else {
    ctx.terminals.registerBackend(stubBackend("gitbash", "git-bash.exe not found; set dsh-shells gitBashPath config"));
  }

  registerPanelRemote(ctx);
}

/** Windows 上自动发现 git-bash.exe。非 Windows 返回空。 */
function findGitBash() {
  if (process.platform !== "win32") return "";
  const candidates = [
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      // 同步探测在 apply 阶段可接受（启动一次）
      if (existsSync(candidate)) return candidate;
    } catch {}
  }
  return "";
}
