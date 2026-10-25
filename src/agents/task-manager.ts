/**
 * 后台一次性任务的生命周期管理（F14-F17/G7）。
 * 进程内 Map、自增 id；runner 异常全部转「已失败」状态，主进程不退出（N3）。
 * 跨会话不持久化：主程序退出即清零（不做的事）。
 */
export interface AgentTask {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  output: string;
  cancel: () => void;
}

export class TaskManager {
  private readonly tasks = new Map<string, AgentTask>();
  private nextId = 1;

  /** 登记任务并立即触发 runner；完成 / 失败异步写回任务对象。 */
  create(name: string, runner: () => Promise<string>, cancel: () => void): AgentTask {
    const id = String(this.nextId++);
    const task: AgentTask = { id, name, status: "running", output: "", cancel };
    this.tasks.set(id, task);
    runner()
      .then((output) => {
        task.status = "completed";
        task.output = output;
      })
      .catch((err: unknown) => {
        task.status = "failed";
        task.output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      });
    return task;
  }

  get(id: string): AgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): AgentTask[] {
    return [...this.tasks.values()];
  }

  /** 仅对运行中任务生效：调取消入口，置为已失败，输出固定「用户停止」（F16）。 */
  stop(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    task.cancel();
    task.status = "failed";
    task.output = "Stopped by user";
  }

  /** 返回所有非运行中任务；不删除条目，调用方自行按 id 去重（F17/模块 E）。 */
  drainNotifications(): AgentTask[] {
    return [...this.tasks.values()].filter((task) => task.status !== "running");
  }
}
