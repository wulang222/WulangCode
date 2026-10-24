# MewCode

MewCode 是一个运行在终端里的 AI 编程助手。它基于 Ink + React 构建交互式 TUI，通过 Agent Loop 自主地多轮「思考 → 调用工具 → 查看结果」，直接在你的项目里读写文件、执行命令、搜索代码。

## 功能

- **多协议模型接入**：支持 Anthropic、OpenAI 及 OpenAI 兼容端点，可在启动时选择 Provider。
- **Agent Loop**：自动多轮编排，工具调用结果回填后继续推理，直到任务完成。
- **内置工具**：读取文件、写入文件、编辑文件、执行命令、按模式查找文件、按内容搜索代码。
- **权限检查**：对工具调用做权限判定，避免意外的高风险操作。
- **模块化系统提示**：按优先级拼装系统提示模块，区分稳定内容（可缓存）与每轮变化内容，降低重复计费与首字延迟。
- **规划模式**：`/plan` 进入只读规划、`/do` 按计划执行，提醒按轮次注入。
- **流式输出与工具展示**：实时展示模型回复和工具执行状态。
- **MCP / Hooks 配置预留**：配置文件支持 `mcp_servers` 与 `hooks` 字段。

## 环境要求

- [Bun](https://bun.sh/)（运行与测试均使用 Bun）
- 可访问的模型 API（Anthropic / OpenAI / OpenAI 兼容端点）

## 快速开始

```bash
# 安装依赖
bun install

# 配置模型（见下一节）
cp .mewcode/config.yaml.example .mewcode/config.yaml

# 启动
bun run start
```

## 配置

配置按以下顺序加载并合并（后层覆盖前层）：

1. `~/.mewcode/config.yaml`（用户全局）
2. `<项目>/.mewcode/config.yaml`（项目级）
3. `<项目>/.mewcode/config.local.yaml`（本地覆盖，建议不入库）

示例：

```yaml
providers:
  - name: anthropic
    protocol: anthropic # anthropic | openai | openai-compat
    base_url: https://api.anthropic.com
    model: claude-sonnet-4-5
    thinking: true

  - name: openai-compat
    protocol: openai-compat
    base_url: https://api.example.com/v1
    model: gpt-4o

mcp_servers: []
hooks: []
```

`api_key` 可以写在配置里，也可以省略并通过环境变量提供：

- `anthropic` → `ANTHROPIC_API_KEY`
- `openai` / `openai-compat` → `OPENAI_API_KEY`

**不要把真实密钥提交到仓库。**

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `bun run start` | 启动 TUI |
| `bun test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |

## 目录结构

```
src/
├── main.tsx            # 入口：加载配置、渲染 TUI
├── agent/              # Agent Loop、事件、流式执行器
├── config/             # YAML 配置加载、合并、校验
├── conversation/       # 会话历史管理
├── llm/                # Anthropic / OpenAI 客户端与错误处理
├── permissions/        # 工具权限检查
├── prompt/             # 系统提示拼装、规划模式
├── tools/              # 内置工具（文件、命令、搜索等）
├── tui/                # Ink 界面组件
└── types/              # 共享类型
docs/                   # 各阶段设计文档（spec / plan / task / checklist）
tests/                  # 测试
```

## 开发

```bash
bun install
bun run typecheck
bun test
```

设计文档位于 `docs/day*/`，每个阶段包含 `spec.md`（需求）、`plan.md`（实现计划）、`task.md`（任务拆分）和 `checklist.md`（验收清单）。
