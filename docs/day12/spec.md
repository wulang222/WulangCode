# Worktree 隔离 Spec## 背景上一章 SubAgent 在消息、权限、文件读缓存、token 计数等维度做了隔离，但**文件系统**仍然共享。主 Agent 与后台子 Agent（以及下一章 Agent Team 的队员）在同一时刻并发读写同一份工作目录的文件，会出现读到对方写了一半的文件、互相覆盖修改等并行冲突——本质就是经典的并行开发文件冲突。

Git 分支只能做**时间维度**的隔离（切换分支时工作目录被覆盖，同一时刻只有一个工作目录），不能解决并行问题；切分支还会刷被切文件的 mtime，触发依赖追踪型构建工具的链式重编。

需要的是**空间维度**的隔离：同一仓库同时挂多个工作目录、共享版本库、各自一个分支。这就是 Git Worktree (Git 2.5+) 的能力。本章把 Worktree 能力以**两个工具**的形式暴露给模型，由模型在需要时自行决定何时进入隔离副本、何时退出并清理。

mewcode 现有相关基础设施：
- 工具系统支持「按需暴露」标记，配合工具发现机制可以让某些工具默认不出现在工具清单里，只有被显式发现后才可调用
- SubAgent 定义支持 `isolation` 字段，由上一章解析 frontmatter 时透传
- 工具白名单机制决定异步后台 SubAgent 可用的工具集合
- 项目根 `.mewcode/worktrees/` 是 Worktree 的落盘目录，应由 `.gitignore` 排除

本章不引入 Worktree 间合并策略、跨目录代码同步、多 Agent 并行编排，这些属于上层 / 下一章范畴。

## 目标- **G1**: 为 Worktree 生命周期提供一组底层能力——按 slug 创建（含快速恢复）、读取当前 HEAD 与分支、检测变更、强制清理目录与分支，覆盖创建、状态读取、变更检测、移除四个核心动作
- **G2**: 读取 Worktree 当前 commit SHA 与所在分支时**不启动 git 子进程**，直接通过文件系统解析 git 的 HEAD 与 ref 文件，避免大仓库下子进程启动开销
- **G3**: 所有进入解析过程的 ref 名称都必须通过严格的安全字符与结构校验，遇到任何不安全的 ref 立即视为空，防止路径遍历与 shell 注入
- **G4**: Worktree 目录统一落在仓库内不被追踪的位置 `.mewcode/worktrees/<slug>/`，分支名固定 `worktree-<slug>`；创建时若目录已存在则走快速恢复路径，毫秒级返回
- **G5**: 创建 Worktree 时即便存在同名残留分支也不应失败——分支命名与创建动作应允许覆盖式重建
- **G6**: 创建成功后做四步环境初始化，全部 best-effort，失败只警告不中断：A 把项目级 mewcode 配置目录整体复制到 Worktree；B 配置 Worktree 内的 git hooks 路径，优先使用项目维护的 hooks 目录，回退到默认 hooks 目录；C 当主仓存在大型依赖安装目录时在 Worktree 内建软链复用；D 读取项目根 `.worktreeinclude` 中列出的相对路径，把对应被忽略但运行需要的文件或目录复制到 Worktree
- **G7**: Worktree 能力以**两个工具**形式暴露给模型——「进入 Worktree」与「退出 Worktree」；模型在需要长任务隔离时显式调用，拿到 Worktree 路径、分支、HEAD，然后在后续工具调用里把这些信息作为参数显式传入
- **G8**: 这两个工具默认对模型**不可见**——它们不出现在初始工具清单里，模型必须先通过工具发现机制按关键词搜索到、解锁后才能调用；避免在所有上下文里常驻「你可以开 Worktree」的暗示
- **G9**: 「进入 Worktree」工具对 slug 的校验比通用 ref 校验更严格——只接受字母、数字、连字符、下划线组合，禁止任何路径分隔符与点号，让 Worktree 名永远是一段简单标识
- **G10**: 「退出 Worktree」工具接收 Worktree 路径、分支、仓库根目录三个必填参数，以及一个可选的基准 commit 用于变更检测；未传基准 commit 或检测无变更时执行清理；检测到有变更时保留 Worktree 并在输出里告知路径与分支供模型后续合并
- **G11**: 清理动作分两步——先删除 Worktree 目录，再删除对应分支；任一步失败都不应抛错中断，保证幂等（Worktree 或分支可能已被外部清掉）
- **G12**: 变更检测同时考察工作区状态与 HEAD 是否相对基准 commit 前进；任一探测过程出错统一按「有变更」处理，宁可保留也不要误删
- **G13**: SubAgent 定义中的 `isolation` 字段保留并继续被 frontmatter 解析，但本章不在 SubAgent 启动路径里自动包裹 Worktree——隔离能力的触发完全由模型显式调用 Worktree 工具完成，`isolation` 字段为后续章节扩展预留
- **G14**: 异步后台 SubAgent 的工具白名单包含这两个 Worktree 工具，让后台任务也能在需要时进入隔离副本
- **G15**: 与现有工具协同——Worktree 内工作时由模型自己把 Worktree 路径作为绝对路径参数传给后续读写工具，不改动既有工具签名

## 功能需求### 工具暴露- **F1**: 「进入 Worktree」工具——
  - 入参仅一个 `slug`（必填字符串）
  - 缺失或非法时返回错误结果，并在输出中说明 slug 的字符集要求
  - slug 必须只含字母、数字、连字符、下划线；任何其他字符（含路径分隔符与点号）一律拒绝
  - 校验通过后调用底层创建能力，成功时输出 Worktree 路径、分支名、HEAD commit 三项信息
  - 底层抛错时返回错误结果，输出含错误说明
- **F2**: 「退出 Worktree」工具——
  - 入参：Worktree 路径、分支名、仓库根目录三项必填；基准 commit 可选
  - 任一必填缺失时返回错误结果
  - 当传入基准 commit 时跑变更检测；未传入时视为无变更
  - 无变更时执行清理，输出告知已清理及对应路径
  - 清理过程抛错时返回错误结果，输出含错误说明
  - 有变更时不删除任何东西，输出告知 Worktree 路径与分支供模型决定下一步动作

### Worktree 生命周期能力- **F3**: 按 slug 创建 Worktree 的能力——
  - 未指定仓库根目录时自行解析当前所在的 git 仓库根
  - Worktree 目录路径与分支名按统一规则推导（落在 `.mewcode/worktrees/<slug>`，分支 `worktree-<slug>`）
  - 目录已存在时走快速恢复路径：优先用纯文件系统方式读 HEAD，失败再回退到 git 子进程；不调用 git worktree 创建命令
  - 目录不存在时调用 git worktree 创建（允许同名残留分支被覆盖），创建完成后跑创建后初始化（F7-F11），最后再读 HEAD
  - 返回 Worktree 路径、分支名、HEAD commit、仓库根目录四项
- **F4**: 清理 Worktree 的能力——分两步执行：先用 git 工具命令强制移除 Worktree 目录，再删除对应分支；两步分别独立容错，任一抛错不传递给调用方
- **F5**: 变更检测的能力——
  - 输入 Worktree 路径与基准 commit
  - 工作区有未提交修改时返回有变更
  - 当前 HEAD commit 不等于基准 commit 时返回有变更
  - 检测过程任何环节抛错统一返回有变更（fail-closed）
- **F6**: 提供一段可拼接到 prompt 的 Worktree 提示文本生成能力，描述「你处于 Worktree 中、父目录在哪里、此处修改与父目录隔离」三类事实；本章不强制使用，供调用方按需拼接

### 纯文件系统读取 git 状态- **F7**: 解析 git 目录位置的能力——
  - 仓库根下的 `.git` 不存在时返回空
  - `.git` 是目录时直接返回该路径
  - `.git` 是文件时按其内容解析（要求以 `gitdir:` 开头），取出的相对路径基于仓库根拼成绝对路径
- **F8**: 直接从文件系统读取 Worktree HEAD commit SHA 的能力——读取 Worktree 自身的 git 目录指针，解析 HEAD，处理「在分支上」（再通过 ref 解析拿 SHA）与「detached」（HEAD 直接是 SHA）两种形态；任何异常返回空字符串
- **F9**: 直接从文件系统读取当前所在分支名的能力——解析 HEAD，处于分支时返回分支名，detached 时返回空字符串
- **F10**: HEAD 文件解析能力——
  - 内容形如 `ref: <ref>` 时取出 ref；ref 落在 `refs/heads/<name>` 区域且 name 通过安全校验时视为「在分支上」并返回分支名
  - 非分支区域的符号 ref（例如 bisect）经过安全校验后再走 ref 解析拿 SHA
  - 裸 SHA（匹配 SHA 字符规则）直接返回 SHA
  - 其余形态视为不可解析
- **F11**: ref 解析能力——先在松散 ref 文件位置查；找不到再扫 packed-refs 文件（跳过注释与对象 peel 行）；当 Worktree 自身的 git 目录里找不到时回退到 commondir 指向的共享 git 目录
- **F12**: ref 名称安全校验规则——非空；不以连字符或路径分隔符开头；不含 `..` 段；按路径分隔符切分每段都非空且不为 `.`；整体字符集限定在安全字符集合内

### 创建后初始化（best-effort）- **F13**: 创建后初始化作为一组独立子步骤依次执行，每个子步骤独立容错，单步失败不影响后续步骤，更不阻塞创建主路径
- **F14**: 复制项目级 mewcode 配置目录——把项目根 mewcode 配置目录递归复制到 Worktree 同位置
- **F15**: 配置 hooks 路径——依序探测项目内自定义 hooks 目录与默认 hooks 目录，命中第一个存在的目录后把该绝对路径设为 Worktree 的 hooks 路径
- **F16**: 软链大目录——主仓存在大型依赖安装目录且 Worktree 内无同名目录时建立软链复用
- **F17**: 复制 `.worktreeinclude` 列表——逐行读取项目根 `.worktreeinclude`；跳过空行与注释行；含路径遍历段（`..`）的行直接跳过；对每个相对路径：源不存在跳过；目标父目录按需创建；源为目录时整目录递归复制，否则按单文件复制

### 工具注册与可见性- **F18**: 启动时把这两个 Worktree 工具注册进工具系统
- **F19**: 这两个工具被标记为「按需暴露」——初始工具清单不包含它们；模型通过工具发现机制按描述或名称匹配关键词 `worktree` 后，工具才被解锁并出现在后续工具清单里
- **F20**: 异步后台 SubAgent 的工具白名单包含这两个 Worktree 工具

### SubAgent 定义透传- **F21**: SubAgent 定义中保留 `isolation` 字段，frontmatter 解析继续把该字段透传到定义对象
- **F22**: 本章不在 SubAgent 启动路径里消费 `isolation` 字段——是否进入 Worktree 由模型显式调用工具决定；该字段为后续章节扩展预留

## 非功能需求- **N1**: 工具清单稳定——两个 Worktree 工具默认不暴露，模型的初始上下文不会被它们污染，prompt cache 不抖动
- **N2**: 创建后初始化的任一子步骤失败都不阻塞创建主路径，每个子步骤独立容错
- **N3**: 与既有工具调用路径兼容——Worktree 模块对外能力可在工具的执行入口（异步）中无感调用
- **N4**: 直接从文件系统读取 HEAD 与 ref 必须不启动 git 子进程；创建时若目录已存在的快速恢复路径不调用 git worktree 创建命令
- **N5**: ref 安全校验集中在一处实现；任何不安全 ref 出现在 HEAD 或 packed-refs 中都被丢弃为空字符串，绝不参与后续路径拼接或子进程命令构造
- **N6**: 项目类型检查与测试用例必须全部通过
- **N7**: 中文友好——错误消息按现有项目风格，工具内部输出沿用现有读写工具的语言风格

## 不做的事

- Worktree 间的合并策略（交给上层 `git merge` / `git cherry-pick`）
- 跨 Worktree 代码同步、文件 watcher
- 多 Agent 并行编排 / Agent Team（下一章）
- SubAgent 启动路径里的自动 Worktree 包装（`isolation` 字段仅保留，不消费）
- Worktree 会话持久化与跨进程恢复
- 后台过期 Worktree 自动清理
- 用于 Worktree 管理的 TUI slash 命令
- Windows 平台 symlink 行为保证（best-effort 失败时跳过）

## 验收标准- **AC1**: 解析 git 目录位置的能力在普通 git 仓库根上返回 `<root>/.git`，在 Worktree 内返回 commondir 指向的共享 git 目录路径
- **AC2**: 纯文件系统读取 Worktree HEAD SHA 在合法 Worktree 路径下返回 40 或 64 字符的十六进制 SHA
- **AC3**: 读取当前分支的能力在处于分支时返回分支名，detached 时返回空字符串
- **AC4**: ref 安全校验对 `"../etc"` 返回 false，对 `"refs/heads/main"` 返回 true，对 `"-rf"` 返回 false
- **AC5**: 用 slug `alice` 创建 Worktree 后，`.mewcode/worktrees/alice/` 下落地 Worktree，分支为 `worktree-alice`，返回的路径、分支、HEAD、仓库根四项均非空
- **AC6**: 已存在 Worktree 目录时再次创建走快速恢复——不调用 git worktree 创建命令，毫秒级返回
- **AC7**: 创建后初始化 A——主仓 mewcode 配置目录被整目录复制到 Worktree 同位置
- **AC8**: 创建后初始化 B——主仓存在自定义 hooks 目录时 Worktree 的 hooks 路径被配置为该绝对路径
- **AC9**: 创建后初始化 C——主仓有大型依赖安装目录时 Worktree 内对应路径是软链
- **AC10**: 创建后初始化 D——主仓 `.worktreeinclude` 列出的相对路径被复制到 Worktree
- **AC11**: 变更检测在空 Worktree 且 SHA 匹配基准 commit 时返回无变更；修改任意一个文件后返回有变更；HEAD 已新增 commit 时也返回有变更
- **AC12**: 「进入 Worktree」工具用合法 slug 调用时成功返回多行输出，含 Worktree 路径、分支、HEAD 三项信息
- **AC13**: 「进入 Worktree」工具用非法 slug（含路径遍历）调用时返回错误结果，输出含字符集要求说明
- **AC14**: 「退出 Worktree」工具在无变更时清理 Worktree 并输出已清理；有变更时保留 Worktree 并在输出里告知路径与分支
- **AC15**: 工具清单接口在默认状态下不含这两个 Worktree 工具；通过工具发现机制按 `worktree` 关键词搜索并解锁后，再次获取工具清单时这两个工具出现
- **AC16**: 异步后台 SubAgent 的工具白名单包含这两个 Worktree 工具
- **AC17**: SubAgent 定义解析器在 frontmatter 含 `isolation: worktree` 时能正确把该值透传到定义对象
- **AC18**: 项目类型检查与测试用例全部通过
- **AC19**: 通过 tmux 实跑 mewcode：用工具发现机制加载「进入 Worktree」工具并调用后，磁盘上出现 `.mewcode/worktrees/<slug>/`；再调用「退出 Worktree」时清理或保留行为符合变更检测结果