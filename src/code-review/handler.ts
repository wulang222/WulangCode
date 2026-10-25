import type { CommandContext } from "../commands/commands.js";
import { CodeReviewManager, type CodeReviewMember } from "./manager.js";
import { ReviewSession, type CriticEvaluation } from "./session.js";

/**
 * 引号感知 tokenizer：双/单引号内的内容合并为一个 token（剥引号），
 * 其余按空白切。支持 `/code-review request t "fix login bug"` 这类多词参数。
 */
function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * /code-review slash 命令分发（F72/G18）：按第一个 token 分发到 18 个子命令，
 * 未识别返回帮助文本。所有 handler 返回字符串，错误统一转 "Error: ..."。
 */
export function handleCodeReviewCommand(
  ctx: CommandContext,
  manager: CodeReviewManager,
  session: ReviewSession,
): string {
  const args = tokenizeArgs(ctx.args.trim());
  const command = args[0]?.toLowerCase() ?? "";
  const params = args.slice(1);
  try {
    switch (command) {
      case "create":
        return handleCreate(manager, params);
      case "add":
        return handleAddMember(manager, params);
      case "add-critic":
        return handleAddCritic(manager, params);
      case "remove":
        return handleRemoveMember(manager, params);
      case "list":
        return handleListTeams(manager);
      case "status":
        return handleTeamStatus(manager, params);
      case "activate":
        return handleActivateMember(manager, params);
      case "deactivate":
        return handleDeactivateMember(manager, params);
      case "request":
        return handleCreateRequest(session, params);
      case "requests":
        return handleListRequests(session);
      case "comment":
        return handleAddComment(session, params);
      case "accept":
        return handleAcceptComment(session, params);
      case "reject":
        return handleRejectComment(session, params);
      case "report":
        return handleGenerateReport(session, params);
      case "approve":
        return handleApproveRequest(session, params);
      case "reject-request":
        return handleRejectRequest(session, params);
      case "critic":
        return handleCriticEvaluate(session, params);
      case "critic-summary":
        return handleCriticSummary(session, params);
      default:
        return showCodeReviewHelp();
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

/** 解析 `name email role expertise1,expertise2` 形态的成员参数。 */
function parseMemberParams(params: string[]): Omit<CodeReviewMember, "active"> {
  const [name, email, role, expertiseStr] = params;
  if (!name || !email || !role) {
    throw new Error("usage: <name> <email> <role> [expertise1,expertise2,...]");
  }
  return {
    name,
    email,
    role: role as CodeReviewMember["role"],
    expertise: expertiseStr ? expertiseStr.split(",").filter(Boolean) : [],
  };
}

function requireParam(params: string[], count: number, usage: string): string[] {
  if (params.length < count) throw new Error(`usage: ${usage}`);
  return params;
}

function handleCreate(manager: CodeReviewManager, params: string[]): string {
  requireParam(params, 1, "/code-review create <team-name> [name email role expertise...]");
  const teamName = params[0]!;
  if (manager.getTeam(teamName)) return `Team '${teamName}' already exists.`;
  // 无成员参数时用默认三人组（与 createDefaultCodeReviewTeam 一致的脚手架）
  const members: Omit<CodeReviewMember, "active">[] =
    params.length >= 4
      ? [parseMemberParams(params.slice(1))]
      : [
          { name: "alice", email: "alice@example.com", role: "reviewer", expertise: ["typescript"] },
          { name: "bob", email: "bob@example.com", role: "reviewer", expertise: ["testing"] },
          { name: "charlie", email: "charlie@example.com", role: "junior", expertise: ["docs"] },
        ];
  manager.createTeam(teamName, members);
  return `Team '${teamName}' created with ${members.length} member(s).`;
}

function handleAddMember(manager: CodeReviewManager, params: string[]): string {
  const [teamName] = requireParam(params, 1, "/code-review add <team> <name> <email> <role> [expertise]");
  const member = parseMemberParams(params.slice(1));
  manager.addMember(teamName!, member);
  return `Member '${member.name}' added to team '${teamName}'.`;
}

function handleAddCritic(manager: CodeReviewManager, params: string[]): string {
  const [teamName] = requireParam(params, 1, "/code-review add-critic <team> <name> <email> [expertise]");
  const [name, email, expertiseStr] = params.slice(1);
  if (!name || !email) throw new Error("usage: /code-review add-critic <team> <name> <email> [expertise]");
  manager.addMember(teamName!, {
    name,
    email,
    role: "critic",
    expertise: expertiseStr ? expertiseStr.split(",").filter(Boolean) : [],
  });
  return `Critic '${name}' added to team '${teamName}'.`;
}

function handleRemoveMember(manager: CodeReviewManager, params: string[]): string {
  const [teamName, memberName] = requireParam(params, 2, "/code-review remove <team> <member>");
  manager.removeMember(teamName!, memberName!);
  return `Member '${memberName}' removed from team '${teamName}'.`;
}

function handleListTeams(manager: CodeReviewManager): string {
  const teams = manager.listTeams();
  if (teams.length === 0) return "No review teams.";
  return teams
    .map((t) => {
      const active = t.members.filter((m) => m.active).length;
      return `${t.name} (${active}/${t.members.length} active)`;
    })
    .join("\n");
}

function handleTeamStatus(manager: CodeReviewManager, params: string[]): string {
  const [teamName] = requireParam(params, 1, "/code-review status <team>");
  return manager.getTeamSummary(teamName!);
}

function handleActivateMember(manager: CodeReviewManager, params: string[]): string {
  const [teamName, memberName] = requireParam(params, 2, "/code-review activate <team> <member>");
  manager.activateMember(teamName!, memberName!);
  return `Member '${memberName}' activated in team '${teamName}'.`;
}

function handleDeactivateMember(manager: CodeReviewManager, params: string[]): string {
  const [teamName, memberName] = requireParam(params, 2, "/code-review deactivate <team> <member>");
  manager.deactivateMember(teamName!, memberName!);
  return `Member '${memberName}' deactivated in team '${teamName}'.`;
}

function handleCreateRequest(session: ReviewSession, params: string[]): string {
  // /code-review request <team> "<title>" "<description>" [branch] [files...]
  const [teamName, title, description, branch = "main", ...files] = requireParam(
    params,
    3,
    '/code-review request <team> "<title>" "<description>" [branch] [files...]',
  );
  const request = session.createReviewRequest(
    teamName!,
    stripQuotes(title!),
    stripQuotes(description!),
    "current-user",
    branch,
    files.map(stripQuotes),
  );
  return `Created review request '${request.id}' with ${request.reviewers.length} reviewer(s).`;
}

function handleListRequests(session: ReviewSession): string {
  const requests = session.listRequests();
  if (requests.length === 0) return "No review requests.";
  return requests
    .map((r) => `${r.id} [${r.status}] ${r.title} (${r.comments.length} comment(s))`)
    .join("\n");
}

function handleAddComment(session: ReviewSession, params: string[]): string {
  // /code-review comment <reqId> "<content>" [file] [line]
  const [reqId, content, file, lineStr] = requireParam(params, 2, '/code-review comment <reqId> "<content>" [file] [line]');
  const comment = session.addComment(
    reqId!,
    "current-user",
    stripQuotes(content!),
    file ? stripQuotes(file) : undefined,
    lineStr ? parseInt(lineStr, 10) : undefined,
  );
  return `Comment '${comment.id}' added.`;
}

function handleAcceptComment(session: ReviewSession, params: string[]): string {
  const [reqId, commentId, response] = requireParam(params, 2, '/code-review accept <reqId> <commentId> [response]');
  session.acceptComment(reqId!, commentId!, response ? stripQuotes(response) : undefined);
  return `Comment '${commentId}' accepted.`;
}

function handleRejectComment(session: ReviewSession, params: string[]): string {
  const [reqId, commentId, response] = requireParam(params, 2, '/code-review reject <reqId> <commentId> [response]');
  session.rejectComment(reqId!, commentId!, response ? stripQuotes(response) : undefined);
  return `Comment '${commentId}' rejected.`;
}

function handleGenerateReport(session: ReviewSession, params: string[]): string {
  const [reqId] = requireParam(params, 1, "/code-review report <reqId>");
  const summary = session.generateFinalReport(reqId!);
  return session.formatFinalReport(summary);
}

function handleApproveRequest(session: ReviewSession, params: string[]): string {
  const [reqId] = requireParam(params, 1, "/code-review approve <reqId>");
  session.updateRequestStatus(reqId!, "approved");
  return `Request '${reqId}' approved.`;
}

function handleRejectRequest(session: ReviewSession, params: string[]): string {
  const [reqId] = requireParam(params, 1, "/code-review reject-request <reqId>");
  session.updateRequestStatus(reqId!, "rejected");
  return `Request '${reqId}' rejected.`;
}

function handleCriticEvaluate(session: ReviewSession, params: string[]): string {
  // /code-review critic <reqId> <commentId> <evaluation> "<reasoning>"
  const [reqId, commentId, evaluation, reasoning] = requireParam(
    params,
    4,
    '/code-review critic <reqId> <commentId> <reasonable|unreasonable|partially-reasonable> "<reasoning>"',
  );
  const valid: CriticEvaluation[] = ["reasonable", "unreasonable", "partially-reasonable"];
  if (!valid.includes(evaluation as CriticEvaluation)) {
    throw new Error(`evaluation must be one of: ${valid.join(", ")}`);
  }
  const assessment = session.addCriticAssessment(
    reqId!,
    commentId!,
    "critic-1",
    evaluation as CriticEvaluation,
    stripQuotes(reasoning!),
  );
  return `Critic assessment '${assessment.evaluation}' recorded for comment '${commentId}'.`;
}

function handleCriticSummary(session: ReviewSession, params: string[]): string {
  const [reqId] = requireParam(params, 1, "/code-review critic-summary <reqId>");
  return session.getCriticSummary(reqId!);
}

/** 剥掉参数里的成对引号（LLM 与手输都常见）。 */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function showCodeReviewHelp(): string {
  return [
    "Usage: /code-review <command> [args]",
    "",
    "Teams:",
    "  create <team> [name email role expertise]   Create a review team",
    "  add <team> <name> <email> <role> [expertise] Add a member",
    "  add-critic <team> <name> <email> [expertise] Add a critic",
    "  remove <team> <member>                       Remove a member",
    "  list                                         List teams",
    "  status <team>                                Team summary",
    "  activate <team> <member>                     Activate a member",
    "  deactivate <team> <member>                   Deactivate a member",
    "",
    "Review requests:",
    '  request <team> "<title>" "<desc>" [branch] [files...]  Create request',
    "  requests                                     List requests",
    '  comment <reqId> "<content>" [file] [line]    Add a comment',
    "  accept <reqId> <commentId> [response]        Accept a comment",
    "  reject <reqId> <commentId> [response]        Reject a comment",
    "  report <reqId>                               Generate final report",
    "  approve <reqId>                              Approve request",
    "  reject-request <reqId>                       Reject request",
    "",
    "Critic:",
    '  critic <reqId> <commentId> <evaluation> "<reasoning>"  Evaluate a comment',
    "  critic-summary <reqId>                       Critic summary",
  ].join("\n");
}
