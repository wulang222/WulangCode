import { CodeReviewManager, type CodeReviewMember } from "./manager.js";

/** 评审请求状态机。 */
export type ReviewRequestStatus =
  | "pending"
  | "in-review"
  | "approved"
  | "rejected"
  | "changes-requested";

/** 评论对 Critic 评估的处理结果。 */
export type CommentResolution = "accepted" | "rejected" | "pending" | "resolved";

/** Critic 对评论合理性的评估结论。 */
export type CriticEvaluation = "reasonable" | "unreasonable" | "partially-reasonable";

/** Critic 评估（F70）：评论 ID + Critic 名 + 评估 + 推理 + 时间戳。 */
export interface CriticAssessment {
  commentId: string;
  critic: string;
  evaluation: CriticEvaluation;
  reasoning: string;
  timestamp: string;
}

/** 评论（F69/F70）：解决状态、作者回复、解决时间、Critic 评估列表。 */
export interface ReviewComment {
  id: string;
  reviewer: string;
  file?: string;
  line?: number;
  content: string;
  timestamp: string;
  resolved: boolean;
  resolution?: CommentResolution;
  authorResponse?: string;
  resolutionTimestamp?: string;
  criticAssessments: CriticAssessment[];
}

/** 评审请求（F68）。 */
export interface ReviewRequest {
  id: string;
  title: string;
  description: string;
  author: string;
  branch: string;
  files: string[];
  status: ReviewRequestStatus;
  createdAt: string;
  updatedAt: string;
  reviewers: CodeReviewMember[];
  comments: ReviewComment[];
}

/** 文件级反馈聚合（F71）。 */
export interface FileFeedback {
  file: string;
  comments: ReviewComment[];
  accepted: number;
  rejected: number;
  pending: number;
}

/** 关键发现（F71）：报告里的单条摘要行。 */
export interface CommentIssue {
  commentId: string;
  reviewer: string;
  content: string;
  resolution: CommentResolution;
  criticEvaluation?: CriticEvaluation;
}

/** 最终报告（F71）。 */
export interface ReviewSummary {
  requestId: string;
  title: string;
  totalComments: number;
  accepted: number;
  rejected: number;
  pending: number;
  verdict: string;
  keyFindings: CommentIssue[];
  fileFeedback: FileFeedback[];
}

/**
 * 评审会话（F67-F71）：维护评审请求、评论、Critic 评估与最终报告。
 * 请求保存在内存 map（持久化由评审团队 JSON 承担团队侧；请求生命周期较短）。
 */
export class ReviewSession {
  private requests = new Map<string, ReviewRequest>();
  private manager: CodeReviewManager;
  private workDir: string;
  private commentCounter = 0;

  constructor(workDir: string, manager: CodeReviewManager) {
    this.workDir = workDir;
    this.manager = manager;
    void this.loadRequests();
  }

  /** 请求持久化占位：本期请求不做落盘，团队配置已由 Manager 持久化。 */
  private async loadRequests(): Promise<void> {}

  /** 创建评审请求（F68）：校验团队存在、活跃 reviewer 非空。 */
  createReviewRequest(
    teamName: string,
    title: string,
    description: string,
    author: string,
    branch: string,
    files: string[],
  ): ReviewRequest {
    const team = this.manager.getTeam(teamName);
    if (!team) throw new Error(`Team '${teamName}' not found`);
    const reviewers = this.manager.getActiveReviewers(teamName);
    if (reviewers.length === 0) {
      throw new Error(`No active reviewers in team '${teamName}'`);
    }
    const now = new Date().toISOString();
    const request: ReviewRequest = {
      id: `review-${Date.now()}`,
      title,
      description,
      author,
      branch,
      files,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      reviewers,
      comments: [],
    };
    this.requests.set(request.id, request);
    return request;
  }

  getRequest(id: string): ReviewRequest | undefined {
    return this.requests.get(id);
  }

  listRequests(): ReviewRequest[] {
    return [...this.requests.values()];
  }

  updateRequestStatus(id: string, status: ReviewRequestStatus): ReviewRequest {
    const request = this.getRequiredRequest(id);
    request.status = status;
    request.updatedAt = new Date().toISOString();
    return request;
  }

  /** 新增评论（F69 上）：id = comment-<ts>-<counter>。 */
  addComment(
    requestId: string,
    reviewer: string,
    content: string,
    file?: string,
    line?: number,
  ): ReviewComment {
    const request = this.getRequiredRequest(requestId);
    this.commentCounter += 1;
    const comment: ReviewComment = {
      id: `comment-${Date.now()}-${this.commentCounter}`,
      reviewer,
      content,
      timestamp: new Date().toISOString(),
      resolved: false,
      criticAssessments: [],
    };
    if (file !== undefined) comment.file = file;
    if (line !== undefined) comment.line = line;
    request.comments.push(comment);
    request.updatedAt = new Date().toISOString();
    return comment;
  }

  /** 接受评论（F69 下）：置 resolution=accepted，可附作者回复。 */
  acceptComment(requestId: string, commentId: string, authorResponse?: string): ReviewComment {
    return this.resolveCommentInternal(requestId, commentId, "accepted", authorResponse);
  }

  /** 拒绝评论（F69 下）：置 resolution=rejected，可附作者回复。 */
  rejectComment(requestId: string, commentId: string, authorResponse?: string): ReviewComment {
    return this.resolveCommentInternal(requestId, commentId, "rejected", authorResponse);
  }

  /** 解决评论（F69 下）：置 resolved=true + resolution=resolved。 */
  resolveComment(requestId: string, commentId: string, authorResponse?: string): ReviewComment {
    return this.resolveCommentInternal(requestId, commentId, "resolved", authorResponse);
  }

  /** 添加 Critic 评估（F70）：追加到目标评论的 criticAssessments。 */
  addCriticAssessment(
    requestId: string,
    commentId: string,
    criticName: string,
    evaluation: CriticEvaluation,
    reasoning: string,
  ): CriticAssessment {
    const comment = this.getRequiredComment(requestId, commentId);
    const assessment: CriticAssessment = {
      commentId,
      critic: criticName,
      evaluation,
      reasoning,
      timestamp: new Date().toISOString(),
    };
    comment.criticAssessments.push(assessment);
    const request = this.getRequiredRequest(requestId);
    request.updatedAt = new Date().toISOString();
    return assessment;
  }

  /** Critic 总结（F71）：按评论列出全部 Critic 评估。 */
  getCriticSummary(requestId: string): string {
    const request = this.getRequiredRequest(requestId);
    const lines: string[] = [`Critic Summary for '${request.title}':`];
    let found = false;
    for (const comment of request.comments) {
      for (const a of comment.criticAssessments) {
        found = true;
        lines.push(
          `  - [${a.evaluation}] ${a.critic} on comment '${comment.id}' (${comment.reviewer}): ${a.reasoning}`,
        );
      }
    }
    if (!found) lines.push("  (no critic assessments yet)");
    return lines.join("\n");
  }

  /** 最终报告生成（F71）：按文件聚合 + 统计 + 结论 + 关键发现。 */
  generateFinalReport(requestId: string): ReviewSummary {
    const request = this.getRequiredRequest(requestId);
    const accepted = request.comments.filter((c) => c.resolution === "accepted").length;
    const rejected = request.comments.filter((c) => c.resolution === "rejected").length;
    const pending = request.comments.filter(
      (c) => c.resolution === undefined || c.resolution === "pending",
    ).length;

    // 按文件聚合：无 file 的归入 "(general)"
    const byFile = new Map<string, ReviewComment[]>();
    for (const c of request.comments) {
      const key = c.file ?? "(general)";
      const list = byFile.get(key) ?? [];
      list.push(c);
      byFile.set(key, list);
    }
    const fileFeedback: FileFeedback[] = [...byFile.entries()].map(([file, comments]) => ({
      file,
      comments,
      accepted: comments.filter((c) => c.resolution === "accepted").length,
      rejected: comments.filter((c) => c.resolution === "rejected").length,
      pending: comments.filter((c) => c.resolution === undefined || c.resolution === "pending")
        .length,
    }));

    const verdict =
      pending > 0
        ? "changes-requested"
        : rejected > accepted
          ? "rejected"
          : accepted > 0
            ? "approved-with-comments"
            : "approved";

    const keyFindings: CommentIssue[] = request.comments.map((c) => ({
      commentId: c.id,
      reviewer: c.reviewer,
      content: c.content,
      resolution: c.resolution ?? "pending",
      criticEvaluation: c.criticAssessments.at(-1)?.evaluation,
    }));

    return {
      requestId: request.id,
      title: request.title,
      totalComments: request.comments.length,
      accepted,
      rejected,
      pending,
      verdict,
      keyFindings,
      fileFeedback,
    };
  }

  /** 报告格式化（F71）：人读多行文本。 */
  formatFinalReport(summary: ReviewSummary): string {
    const lines: string[] = [
      `Code Review Report: ${summary.title} (${summary.requestId})`,
      "",
      `Total Comments: ${summary.totalComments}`,
      `Accepted: ${summary.accepted}`,
      `Rejected: ${summary.rejected}`,
      `Pending: ${summary.pending}`,
      `Verdict: ${summary.verdict}`,
    ];
    if (summary.fileFeedback.length > 0) {
      lines.push("", "File-specific Feedback:");
      for (const fb of summary.fileFeedback) {
        lines.push(
          `  ${fb.file} — ${fb.comments.length} comment(s) (accepted: ${fb.accepted}, rejected: ${fb.rejected}, pending: ${fb.pending})`,
        );
      }
    }
    if (summary.keyFindings.length > 0) {
      lines.push("", "Key Findings:");
      for (const f of summary.keyFindings) {
        lines.push(`  - [${f.resolution}] ${f.reviewer}: ${f.content}`);
      }
    }
    return lines.join("\n");
  }

  private getRequiredRequest(id: string): ReviewRequest {
    const request = this.requests.get(id);
    if (!request) throw new Error(`Review request '${id}' not found`);
    return request;
  }

  private getRequiredComment(requestId: string, commentId: string): ReviewComment {
    const request = this.getRequiredRequest(requestId);
    const comment = request.comments.find((c) => c.id === commentId);
    if (!comment) throw new Error(`Comment '${commentId}' not found in request '${requestId}'`);
    return comment;
  }

  private resolveCommentInternal(
    requestId: string,
    commentId: string,
    resolution: CommentResolution,
    authorResponse?: string,
  ): ReviewComment {
    const comment = this.getRequiredComment(requestId, commentId);
    comment.resolved = resolution === "resolved" || resolution === "accepted" || resolution === "rejected";
    comment.resolution = resolution;
    if (authorResponse !== undefined) comment.authorResponse = authorResponse;
    comment.resolutionTimestamp = new Date().toISOString();
    const request = this.getRequiredRequest(requestId);
    request.updatedAt = new Date().toISOString();
    return comment;
  }
}
