/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-agent-teams/snapshot
 */
import type { Context } from '@deepseek-ai/cordis';
import type { MemberStatus, TeamState } from './types.ts';
/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
/** One member row of the activity snapshot. */
export interface TeamActivityMember {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort: string;
    readonly executionPrompt: string;
    readonly status: MemberStatus;
    readonly activity: 'working' | 'idle' | 'unknown';
    readonly progress: number;
    readonly done: number;
    readonly total: number;
    readonly currentTask: string;
    readonly unread: number;
}
/** One task row of the activity snapshot. */
export interface TeamActivityTask {
    readonly id: string;
    readonly subject: string;
    readonly description: string;
    readonly status: string;
    readonly state: VisualTaskState;
    readonly assignee: string;
    readonly model: string;
    readonly dependencies: readonly string[];
    readonly depth: number;
    readonly kind?: string;
    readonly round?: number;
    readonly verdict?: string;
    /**
     * Set when this task's verdict or auto-generated work order no longer
     * describes the current bytes; the panel must not render a bare pass badge.
     */
    readonly verdictStale?: string;
    /** Durable last-write stamp; drives the finished-member ordering (issue #192). */
    readonly updatedAt: number;
}
/** One captain-inbox preview row. */
export interface TeamActivityMessage {
    readonly from: string;
    readonly content: string;
}
/** The full panel payload for one team. */
export interface TeamActivitySnapshot {
    readonly workspace: string;
    readonly teamId: string;
    readonly name: string;
    readonly description?: string;
    readonly captainSessionId: string;
    readonly phase: 'staged' | 'running';
    readonly planReviewState?: 'awaiting_review' | 'awaiting_feedback';
    readonly halted?: boolean;
    readonly members: readonly TeamActivityMember[];
    readonly tasks: readonly TeamActivityTask[];
    readonly messageCount: number;
    readonly captainInbox: readonly TeamActivityMessage[];
    /** Present when the snapshot could audit the workspace bytes. */
    readonly loopState?: string;
    readonly deliverable?: boolean;
    readonly delivery?: {
        readonly ok: boolean;
        readonly blockers: readonly string[];
        readonly warnings: readonly string[];
    };
}
/** Snapshot projection switches for live and archived teams. */
export interface TeamSnapshotOptions {
    /** Historic review must retain members that were marked removed at shutdown. */
    readonly includeRemoved?: boolean;
    /** Archived teams have no meaningful live activity after their sessions stop. */
    readonly historic?: boolean;
    /**
     * Absolute workspace path of the owning workspace. When present, the snapshot
     * audits the current bytes behind every recorded verdict, so the panel and
     * the model-facing status tool cannot report different delivery verdicts.
     */
    readonly workspacePath?: string;
}
/** One state root the activity panel audits, with its display name. */
export interface SnapshotRoot {
    /** Display name: the workspace title, or the working directory's final segment. */
    readonly workspace: string;
    /** Absolute directory holding one `<teamId>/` subdirectory per team. */
    readonly stateRoot: string;
    /** Directory whose bytes the snapshot audits (the owning workspace path). */
    readonly workspacePath: string;
}
/** Options for {@link canonicalDirectory}. */
export interface CanonicalDirectoryOptions {
    /** How long one lookup may take; defaults to {@link REALPATH_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /** Lookup implementation; defaults to `fs.realpath` (a seam for tests). */
    readonly lookup?: (path: string) => Promise<string>;
}
/**
 * Canonical spelling of one directory.
 *
 * The workspace registry stores `fs.realpath`-normalized paths, so a directory
 * spelled differently elsewhere (`/tmp/x` vs `/private/tmp/x`) would otherwise
 * contribute a second root for one state directory and return every team
 * snapshot twice. A path that no longer resolves keeps its raw spelling: a
 * vanished directory must not silently drop a session whose team files are
 * still on disk.
 *
 * The lookup is bounded because it runs on every poll: a session cwd on a dead
 * network mount must cost one slow request, not a frozen panel.
 * @param path - directory to canonicalize.
 * @param options - lookup timeout and an optional lookup implementation.
 * @returns the canonical path, or the raw spelling when it does not resolve.
 */
export declare function canonicalDirectory(path: string, options?: CanonicalDirectoryOptions): Promise<string>;
/**
 * Every state root the Web surface must audit: registered workspaces plus the
 * working directory of every live session.
 *
 * A session opened on a git worktree — or on any directory the user never
 * registered as a Workspace — keeps its teams under its own `<cwd>/<stateDir>`.
 * A registry-only scan therefore hides exactly the teams created there, and the
 * Web panel renders empty for that session while `halt`/`plan` keep working
 * (they derive the root from `captain.session.header.cwd`). Auditing the live
 * session cwds keeps the panel on the same root as those routes, including
 * their `?? process.cwd()` fallback for a session without a recorded cwd.
 * @param workspaces - registered workspaces, in registry order.
 * @param sessionCwds - working directories of live sessions; a raw spelling is
 * fine, because the dedupe key is the resolved state root.
 * @param stateDir - configured state directory name.
 * @returns one root per distinct state root, registry order first.
 */
export declare function snapshotRoots(workspaces: readonly {
    readonly path: string;
    readonly title: string;
}[], sessionCwds: readonly string[], stateDir: string): Promise<SnapshotRoot[]>;
/**
 * Resolve `snapshotRoots` against the live runtime: registered workspaces plus
 * every live session's working directory.
 *
 * Kept as one function so the state route cannot drift from the writers'
 * `header.cwd ?? process.cwd()` rule without a test failing.
 *
 * Session cwds are canonicalized first: while a directory has no state dir yet,
 * `realpath` on the state root fails and two spellings of one directory would
 * each keep their raw string, defeating the dedupe.
 * @param ctx - the plugin context (reads `ctx.agents.list()`).
 * @param workspaces - registered workspaces, in registry order.
 * @param stateDir - configured state directory name.
 * @returns one root per distinct state root, registry order first. A failing
 * agent registry degrades to the registered workspaces instead of throwing.
 */
export declare function resolveSnapshotRoots(ctx: Context, workspaces: readonly {
    readonly path: string;
    readonly title: string;
}[], stateDir: string): Promise<SnapshotRoot[]>;
/** Compact `provider/model` route for the activity panel, or just the model. */
export declare function memberModelRoute(member: {
    provider?: string;
    model?: string;
} | undefined): string;
/**
 * Assemble one team snapshot from its durable files plus live activity.
 * @param ctx - the plugin context (injects `subagents`, used for activity).
 * @param stateRoot - resolved absolute state root of the owning workspace.
 * @param workspace - display name of the owning workspace.
 * @param state - the durable team record.
 * @returns the panel snapshot.
 */
export declare function assembleTeamSnapshot(ctx: Context, stateRoot: string, workspace: string, state: TeamState, options?: TeamSnapshotOptions): Promise<TeamActivitySnapshot>;
/**
 * Collect every team under the given workspace state roots.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs (resolved absolute roots).
 * @returns the snapshots in stable order (workspace, then team id).
 */
export declare function collectTeamsActivity(ctx: Context, roots: readonly {
    workspace: string;
    stateRoot: string;
    workspacePath?: string;
}[]): Promise<TeamActivitySnapshot[]>;
/**
 * Collect every archived team under the given workspace state roots (the
 * `archive/` subdirectory of each state root). Used by the historic panel
 * path to restore full team detail after deletion.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs.
 * @returns the archived snapshots in stable order.
 */
export declare function collectArchivedTeamsActivity(ctx: Context, roots: readonly {
    workspace: string;
    stateRoot: string;
}[]): Promise<TeamActivitySnapshot[]>;
