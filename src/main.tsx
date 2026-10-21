#!/usr/bin/env bun
import { closeSync, openSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import React from "react";
import { render } from "ink";
import cliCursor from "cli-cursor";
import { loadConfig } from "./config/config.js";
import { App } from "./tui/app.js";

const require = createRequire(import.meta.url);

let ttyFd: number | null = null;
const origShow = cliCursor.show.bind(cliCursor);

function writeTty(data: string): void {
  if (ttyFd === null) return;
  try {
    writeSync(ttyFd, data);
  } catch {
    // tty 已关闭时忽略
  }
}

function hideCursor(): void {
  try {
    ttyFd = openSync("/dev/tty", "w");
    writeTty("\x1b[?25l");
  } catch {
    ttyFd = null;
  }
  cliCursor.show = () => {};
  // Ink 在重渲染时会走 cli-cursor 的 show，把它换成空操作，避免光标闪烁。
  try {
    const loaded = require("cli-cursor") as { show: typeof cliCursor.show };
    loaded.show = () => {};
  } catch {
    // 依赖缺失时只改当前绑定
  }
}

function restoreCursor(): void {
  cliCursor.show = origShow;
  try {
    const loaded = require("cli-cursor") as { show: typeof cliCursor.show };
    loaded.show = origShow;
  } catch {
    // 忽略
  }
  writeTty("\x1b[?25h");
  if (ttyFd !== null) {
    try {
      closeSync(ttyFd);
    } catch {
      // 已经关掉
    }
    ttyFd = null;
  }
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  hideCursor();
  process.on("exit", restoreCursor);
  const instance = render(
    <App providers={cfg.providers} mcpServers={cfg.mcp_servers} hooks={cfg.hooks} />,
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    restoreCursor();
  }
}

await main();
