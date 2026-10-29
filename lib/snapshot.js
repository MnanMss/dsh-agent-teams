/**
 * Team activity snapshot assembly for the activity panel.
 *
 * Server-side assembly mirrors the Claude Code desktop teamWatcher: read the
 * durable team files (the truth source) and enrich with live subagent
 * activity, so the panel always reflects the on-disk state even when a model
 * skipped a tool "ritual" (e.g. not calling update_task on completion).
 * @module dsh-agent-teams/snapshot
 */
import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { memberActivity } from "./members.js";
import { canDeclareDelivery, describeQualityLoop, verdictAuditNotes } from "./quality-gates.js";
import { auditTeamWorkspace } from "./workspace-audit.js";
import { CAPTAIN_KEY, listArchivedTeamIds, readArchivedTeam, readUnreadMailbox, readTeam, taskDepthsById, taskVisualState, } from "./state.js";
/** Upper bound for one `realpath` lookup on the panel's one-second poll. */
const REALPATH_TIMEOUT_MS = 75;
/** How long a timed-out lookup keeps its raw spelling before it is retried. */
const REALPATH_TIMEOUT_COOLDOWN_MS = 30_000;
/**
 * Paths whose lookup timed out, and when they may be looked up again.
 *
 * `realpath` cannot be cancelled: after the race gives up, the syscall keeps a
 * libuv thread until it returns. Re-issuing one every poll on a dead network
 * mount would drain the shared thread pool and stall unrelated filesystem work
 * in the host, so a timed-out path waits out the cooldown instead.
 */
const timedOutPaths = new Map();
/** Remember one timed-out path, keeping the map bounded. */
function rememberTimeout(path) {
    if (timedOutPaths.size >= 64)
        timedOutPaths.clear();
    timedOutPaths.set(path, Date.now() + REALPATH_TIMEOUT_COOLDOWN_MS);
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
export async function canonicalDirectory(path, options = {}) {
    const timeoutMs = options.timeoutMs ?? REALPATH_TIMEOUT_MS;
    const lookup = options.lookup ?? realpath;
    const retryAt = timedOutPaths.get(path);
    if (retryAt !== undefined) {
        if (retryAt > Date.now())
            return path;
        timedOutPaths.delete(path);
    }
    let timer;
    try {
        return await Promise.race([
            lookup(path),
            new Promise((_resolve, reject) => {
                const timeout = new Error(`realpath timed out after ${timeoutMs}ms`);
                timeout.name = 'TimeoutError';
                timer = setTimeout(() => reject(timeout), timeoutMs);
                timer.unref();
            }),
        ]);
    }
    catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError')
            rememberTimeout(path);
        return path;
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
/** True when a filesystem error only means the directory is not there. */
function isMissingDirectory(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
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
export async function snapshotRoots(workspaces, sessionCwds, stateDir) {
    const candidates = [];
    for (const workspace of workspaces)
        candidates.push({ workspace: workspace.title, directory: workspace.path });
    for (const cwd of sessionCwds) {
        if (cwd === '')
            continue;
        // `basename('/')` is empty: keep the path so the panel never shows an
        // unnamed workspace.
        candidates.push({ workspace: basename(cwd) || cwd, directory: cwd });
    }
    const resolved = await Promise.all(candidates.map(async (candidate) => ({
        ...candidate,
        stateRoot: await canonicalDirectory(join(candidate.directory, stateDir)),
    })));
    const roots = new Map();
    for (const root of resolved) {
        // Dedupe on the resolved state root, not on the directory spelling: two
        // directories can share one state root through a symlinked `.agent-teams`,
        // or through a stateDir that escapes with `..`. A shared state root would
        // otherwise return every team in it twice, and the panel would render two
        // cards under one React key.
        if (roots.has(root.stateRoot))
            continue;
        roots.set(root.stateRoot, {
            workspace: root.workspace,
            stateRoot: root.stateRoot,
            // First candidate wins: when two directories share one state root, their
            // state files are the same bytes, so auditing them through either path
            // reads the same content.
            workspacePath: root.directory,
        });
    }
    return [...roots.values()];
}
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
export async function resolveSnapshotRoots(ctx, workspaces, stateDir) {
    let sessionCwds;
    try {
        sessionCwds = await Promise.all(ctx.agents.list().map(async (agent) => {
            let cwd;
            try {
                cwd = agent.session.header.cwd;
            }
            catch (error) {
                // One unreadable header must not drop every other worktree root: that
                // is the very symptom this route was fixed for. `snapshotRoots` skips
                // the empty spelling.
                ctx.logger.warn(`agent-teams: skipped a session without a readable cwd: ${String(error)}`);
                return '';
            }
            // Writers use `header.cwd ?? process.cwd()`, and an empty cwd writes a
            // relative state dir that also lands in process.cwd(): mirror both
            // spellings so the panel never skips a team the writers created.
            return await canonicalDirectory(cwd === undefined || cwd === '' ? process.cwd() : cwd);
        }));
    }
    catch (error) {
        // Before this fix the route never touched `ctx.agents`, so a registry that
        // is not ready yet must not turn every panel into a failed request.
        ctx.logger.warn(`agent-teams: live session scan failed, reading registered workspaces only: ${String(error)}`);
        return await snapshotRoots(workspaces, [], stateDir);
    }
    return await snapshotRoots(workspaces, sessionCwds, stateDir);
}
/** The current task of a member: its first unfinished owned task. */
function currentTaskOf(memberName, tasks) {
    for (const task of tasks) {
        if (task.status === 'in_progress' && task.assignee === memberName)
            return task.id;
    }
    return '';
}
/** Compact `provider/model` route for the activity panel, or just the model. */
export function memberModelRoute(member) {
    if (member === undefined)
        return '';
    const provider = member.provider?.trim() ?? '';
    const model = member.model?.trim() ?? '';
    if (provider !== '' && model !== '')
        return `${provider}/${model}`;
    return model;
}
/**
 * Assemble one team snapshot from its durable files plus live activity.
 * @param ctx - the plugin context (injects `subagents`, used for activity).
 * @param stateRoot - resolved absolute state root of the owning workspace.
 * @param workspace - display name of the owning workspace.
 * @param state - the durable team record.
 * @returns the panel snapshot.
 */
export async function assembleTeamSnapshot(ctx, stateRoot, workspace, state, options = {}) {
    const tasks = state.tasks;
    const depths = taskDepthsById(tasks);
    const roster = options.includeRemoved === true
        ? state.members
        : state.members.filter((member) => member.status !== 'removed');
    const activity = options.historic === true
        ? new Map()
        : memberActivity(ctx, roster.map((member) => member.id));
    const unreadByMember = new Map();
    for (const member of roster) {
        try {
            unreadByMember.set(member.name, (await readUnreadMailbox(stateRoot, state.id, member.name)).length);
        }
        catch (error) {
            ctx.logger.warn(`agent-teams: mailbox read failed for ${member.name}: ${String(error)}`);
            unreadByMember.set(member.name, 0);
        }
    }
    const members = roster.map((member) => {
        const owned = tasks.filter((task) => task.assignee === member.name);
        const done = owned.filter((task) => task.status === 'completed').length;
        return {
            id: member.id,
            name: member.name,
            role: member.role ?? '',
            provider: member.provider?.trim() ?? '',
            model: member.model?.trim() ?? '',
            reasoningEffort: member.reasoningEffort?.trim() ?? '',
            executionPrompt: member.executionPrompt ?? '',
            status: member.status,
            activity: options.historic === true
                ? 'idle'
                : member.id !== ''
                    ? (activity.get(member.id) === 'running'
                        ? 'working'
                        : activity.get(member.id) === 'idle' || activity.get(member.id) === 'ready'
                            ? 'idle'
                            : 'unknown')
                    : 'idle',
            progress: owned.length === 0 ? 0 : Math.round((done / owned.length) * 100),
            done,
            total: owned.length,
            currentTask: currentTaskOf(member.name, tasks),
            unread: unreadByMember.get(member.name) ?? 0,
        };
    });
    const captainInbox = await readUnreadMailbox(stateRoot, state.id, CAPTAIN_KEY);
    // The panel must reach the same delivery conclusion as the status tool, so
    // it reads the same current bytes instead of trusting task records alone.
    const audit = options.workspacePath === undefined ? undefined : auditTeamWorkspace(options.workspacePath, state);
    const deliveryCheck = audit === undefined ? canDeclareDelivery(state) : canDeclareDelivery(state, audit);
    const loop = audit === undefined ? describeQualityLoop(state) : describeQualityLoop(state, audit);
    const staleById = new Map();
    if (audit !== undefined) {
        for (const note of verdictAuditNotes(state, audit)) {
            staleById.set(note.taskId, [...staleById.get(note.taskId) ?? [], note.message]);
        }
    }
    return {
        workspace,
        teamId: state.id,
        name: state.name,
        ...state.description !== undefined ? { description: state.description } : {},
        captainSessionId: state.captainSessionId,
        phase: state.phase ?? 'running',
        ...state.phase === 'staged'
            ? { planReviewState: state.planReviewState ?? 'awaiting_review' }
            : {},
        ...state.halted === true ? { halted: true } : {},
        ...audit === undefined ? {} : {
            loopState: loop.state,
            deliverable: loop.deliverable,
            delivery: { ok: deliveryCheck.ok, blockers: [...deliveryCheck.blockers], warnings: [...deliveryCheck.warnings] },
        },
        members,
        tasks: tasks.map((task) => ({
            id: task.id,
            subject: task.subject,
            description: task.description ?? '',
            status: task.status,
            state: taskVisualState(task.status, task.dependencies, tasks),
            assignee: task.assignee ?? '',
            model: memberModelRoute(roster.find((member) => member.name === task.assignee)),
            dependencies: task.dependencies,
            depth: depths.get(task.id) ?? 0,
            ...task.kind === undefined ? {} : { kind: task.kind },
            ...task.round === undefined ? {} : { round: task.round },
            ...task.verdict === undefined ? {} : { verdict: task.verdict },
            ...staleById.get(task.id) === undefined ? {} : { verdictStale: staleById.get(task.id).join('; ') },
            updatedAt: task.updatedAt,
        })),
        messageCount: captainInbox.length
            + members.reduce((count, member) => count + member.unread, 0),
        captainInbox: captainInbox.slice(-5).map((message) => ({
            from: message.from,
            content: message.content,
        })),
    };
}
/**
 * Collect every team under the given workspace state roots.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs (resolved absolute roots).
 * @returns the snapshots in stable order (workspace, then team id).
 */
export async function collectTeamsActivity(ctx, roots) {
    const snapshots = [];
    for (const root of roots) {
        let entries;
        try {
            entries = await readdir(root.stateRoot, { withFileTypes: true });
        }
        catch (error) {
            // A live session cwd can be any directory the user opened, including one
            // this process may not read (EACCES/ENOTDIR/EIO). One unreadable root
            // must not blank every other team's panel.
            if (!isMissingDirectory(error)) {
                ctx.logger.warn(`agent-teams: skipped unreadable state root "${root.stateRoot}": ${String(error)}`);
            }
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const state = await readTeam(root.stateRoot, entry.name).catch((error) => {
                ctx.logger.warn(`agent-teams: unreadable team state "${entry.name}" in workspace "${root.workspace}": ${String(error)}`);
                return undefined;
            });
            if (state === undefined)
                continue;
            try {
                snapshots.push(await assembleTeamSnapshot(ctx, root.stateRoot, root.workspace, state, {
                    ...root.workspacePath === undefined ? {} : { workspacePath: root.workspacePath },
                }));
            }
            catch (error) {
                // A team that cannot be assembled is a broken team, not a broken root:
                // name it, so it does not silently vanish from the panel.
                ctx.logger.warn(`agent-teams: skipped team snapshot "${entry.name}" in workspace "${root.workspace}": ${String(error)}`);
            }
        }
    }
    return snapshots;
}
/**
 * Collect every archived team under the given workspace state roots (the
 * `archive/` subdirectory of each state root). Used by the historic panel
 * path to restore full team detail after deletion.
 * @param ctx - the plugin context.
 * @param roots - `{ workspace, stateRoot }` pairs.
 * @returns the archived snapshots in stable order.
 */
export async function collectArchivedTeamsActivity(ctx, roots) {
    const snapshots = [];
    for (const root of roots) {
        let teamIds;
        try {
            teamIds = await listArchivedTeamIds(root.stateRoot);
        }
        catch (error) {
            // Same rule as the live scan: one unreadable root must not hide the rest.
            if (!isMissingDirectory(error)) {
                ctx.logger.warn(`agent-teams: skipped unreadable archive root "${root.stateRoot}": ${String(error)}`);
            }
            continue;
        }
        for (const teamId of teamIds) {
            const state = await readArchivedTeam(root.stateRoot, teamId).catch((error) => {
                ctx.logger.warn(`agent-teams: unreadable archived team "${teamId}" in workspace "${root.workspace}": ${String(error)}`);
                return undefined;
            });
            if (state === undefined)
                continue;
            try {
                snapshots.push(await assembleTeamSnapshot(ctx, join(root.stateRoot, 'archive'), root.workspace, state, { includeRemoved: true, historic: true }));
            }
            catch (error) {
                ctx.logger.warn(`agent-teams: skipped archived snapshot "${teamId}" in workspace "${root.workspace}": ${String(error)}`);
            }
        }
    }
    return snapshots;
}
