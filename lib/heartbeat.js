/**
 * 心跳主动搭话调度器（设计吸收自 pygmalion 插件的 heartbeat）：
 *
 * 全局单一 tick（默认 60s，unref 不阻塞退出）遍历 heartbeatChats 配置的群，
 * 每 tick 按序过零成本闸门，全过才消耗一次模型回合：
 *   ① 安静时段（heartbeatQuietHours，"HH:MM-HH:MM" 数组，支持跨午夜）
 *   ② 该群 agent 回合进行中（不插队）
 *   ③ 当日主动次数达 heartbeatMaxPerDay（按本地自然日记数）
 *   ④ 上次主动开口后 heartbeatCooldownMinutes 冷却未满
 *   ⑤ 上次心跳判定（含沉默）后 heartbeatRetryMinutes 未满（防止死群每 tick 空转）
 *   ⑥ 群未冷场：最后一条群消息距今不足 heartbeatIdleMinutes（聊得正热不插话）
 * 闸门全过 → get_group_msg_history 拉最近消息构造情境回合，经
 * bridge.dispatchFollowup 投给该群 agent（带完整人格/记忆/会话历史），
 * 模型自主判断开口或沉默：最终文本含 [SILENT] → 出站拦截吞掉不发；
 * 否则正常发送并计次。状态落 mediaDir/heartbeat-state.json（重启保留当日次数）。
 *
 * 与 bridge 的三个接缝（bridge.js 内挂接）：
 *   - sendToChat 出站拦截（options.decisionTarget === true 的最终回复才参与裁决，
 *     避免把排队/插话/错误等插件通知误判为"开口"）
 *   - effectiveInterim：心跳回合未裁决期间强制 false（不漏中间话到群里）
 *   - turn/end 收尾：onTurnEnd 计次落盘并清理回合标记
 * @module dsh-onebot/heartbeat
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SILENT_MARKER = /\[\s*SILENT\s*\]/i;
const QUIET_RANGE_RE = /^(?:(\d{1,2}):?(\d{2})?)\s*-\s*(?:(\d{1,2}):?(\d{2})?)$/;

/** 免打扰时段判定（形态与语义对齐 pygmalion quiet-hours.js）：元素
 * "HH:MM-HH:MM"，容忍 "H:MM-H:MM"/"HHMM-HHMM"；起 > 止视为跨午夜。 */
export function inQuietHours(quietHours, now = new Date()) {
    const hm = now.getHours() * 60 + now.getMinutes();
    return (quietHours ?? []).some((range) => {
        const m = QUIET_RANGE_RE.exec(String(range).trim());
        if (m === null)
            return false;
        const start = Number(m[1]) * 60 + Number(m[2] ?? 0);
        const end = Number(m[3]) * 60 + Number(m[4] ?? 0);
        return start <= end ? hm >= start && hm <= end : hm >= start || hm <= end;
    });
}

function pad(n) { return String(n).padStart(2, '0'); }
function today(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function hhmm(d = new Date()) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

/** 问候与心跳是两种语义：问候是「到点必须送到」，心跳是「闲了才开口」。
 *  因此问候单独一套状态与闸门，不占心跳的每日次数、不被 [SILENT] 静默吞掉、
 *  失败后在窗口内重试；只有模型真的说出话（turn 结束且已出站）才记为当天完成。 */
const GREET_RETRY_MS = 3 * 60_000;
const GREET_IDLE_MINUTES = 3;
const NIGHT_START = 21 * 60 + 30;
const NIGHT_END = 22 * 60 + 25;
const NIGHT_LATE = 22 * 60 + 10;
const FIRST_START = 6 * 60;

/**
 * 当前是否该发问候（纯函数，便于单测）。
 * 窗口：晚安 21:30-22:25（断电前），首问候 06:00-21:29（当天第一次说话）。
 * 00:00-05:59 一律不问候（深夜不喊“早安”）；22:26-23:59 也不补（已过断电点）。
 * @param now - current time.
 * @param g - persisted per-chat greet state { m, n, mAt, nAt }.
 */
export function greetingDue(now, g = {}) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const t = today(now);
    if (mins >= NIGHT_START && mins <= NIGHT_END && g.n !== t)
        return { kind: 'night', date: t, mins, nearEnd: mins >= NIGHT_LATE };
    if (mins >= FIRST_START && mins < NIGHT_START && g.m !== t)
        return { kind: 'first', date: t, mins, nearEnd: false };
    return null;
}

/**
 * Create the heartbeat scheduler.
 * @param deps - config/mediaDir/call/selfId/dispatchFollowup/chatBusy/connected/log.
 */
export function createHeartbeatScheduler(deps) {
    const { config, log } = deps;
    const statePath = join(deps.mediaDir, 'heartbeat-state.json');
    /** Persisted state: { date, spoke: {chatId: count}, lastSpokeAt: {chatId: ms}, lastAttemptAt: {chatId: ms} }. */
    let state = { date: today(), spoke: {}, greet: {}, lastSpokeAt: {}, lastAttemptAt: {} };
    let timer = null;
    let stopped = false;
    let tickRunning = false;
    /** chatId → the undecided heartbeat round { startedAt, decided: null|'silent'|'spoke' }. */
    const pending = new Map();

    async function loadState() {
        try {
            const raw = JSON.parse(await readFile(statePath, 'utf8'));
            if (raw !== null && typeof raw === 'object') {
                state = {
                    date: typeof raw.date === 'string' ? raw.date : today(),
                    spoke: raw.spoke !== null && typeof raw.spoke === 'object' ? raw.spoke : {},
                    lastSpokeAt: raw.lastSpokeAt !== null && typeof raw.lastSpokeAt === 'object' ? raw.lastSpokeAt : {},
                    lastAttemptAt: raw.lastAttemptAt !== null && typeof raw.lastAttemptAt === 'object' ? raw.lastAttemptAt : {},
                    greet: raw.greet !== null && typeof raw.greet === 'object' ? raw.greet : {},
                };
            }
        }
        catch {
            // missing/corrupt state: start clean (daily counts reset — soft limit, acceptable)
        }
    }
    async function saveState() {
        try {
            await mkdir(deps.mediaDir, { recursive: true });
            await writeFile(statePath, JSON.stringify(state), 'utf8');
        }
        catch (error) {
            log('warn', '心跳状态落盘失败: ' + (error instanceof Error ? error.message : String(error)));
        }
    }
    /** Cross the local-midnight line: zero the daily counters, keep timestamps. */
    function rollDate(now) {
        const t = today(now);
        if (state.date !== t) {
            state = { date: t, spoke: {}, greet: state.greet, lastSpokeAt: state.lastSpokeAt, lastAttemptAt: state.lastAttemptAt };
        }
    }

    /** Whether a heartbeat round for this chat is awaiting the model's verdict. */
    function isPending(chatId) { return pending.has(chatId); }

    /** The bridge.sendToChat interception point. Only the agent's final reply
     * (flagged decisionTarget by the interim pipeline) reaches here — plugin
     * notices (queue/steer/error/reset) are structurally excluded. The FIRST
     * such text of a pending round decides it. */
    function interceptOutbound(chatId, text) {
        const round = pending.get(chatId);
        if (round === undefined || round.decided !== null)
            return { swallow: false, text };
        // 两种静默写法都算“没开口”：[SILENT] 与 [沉默]。后者原本会被 sendToChat
        // 丢掉，但会先被记成 spoke（对话没发出去却计了一次），这里统一裁决。
        if (SILENT_MARKER.test(text) || /^\[(沉默|不回|无视)\]$/.test(text.trim())) {
            round.decided = 'silent';
            log('info', '心跳回合 [' + chatId + '] 模型选择沉默');
            return { swallow: true, text };
        }
        round.decided = 'spoke';
        const stripped = text.replace(/\[\s*SILENT\s*\]\s*/i, '');
        return { swallow: false, text: stripped === '' ? text : stripped };
    }

    /** The bridge turn/end finalization: count & persist, clear the round. A
     * round with no text outbound (pure tool calls / empty / error turn) counts
     * as silent — it stays marked until here so a racing final send still hits
     * the interception. */
    function onTurnEnd(chatId) {
        const round = pending.get(chatId);
        if (round === undefined)
            return;
        pending.delete(chatId);
        // 问候回合：只有真的开口（出站成功）才写当天已完成；沉默/空回复/出错
        // 一律不写，留给窗口内下一次 tick 重试——这是「每日必达」的关键。
        if (round.greetKind !== undefined) {
            // 刚问候过就别紧接着再来一句随机搭话：占住心跳的重试闸，
            // 但不动 spoke/lastSpokeAt（问候不占每日 5 次）。
            state.lastAttemptAt[chatId] = Date.now();
            if (round.decided === 'spoke') {
                const g = state.greet[chatId] ?? {};
                state.greet[chatId] = { ...g, [round.greetKind === 'night' ? 'n' : 'm']: today() };
                log('info', '心跳问候 [' + chatId + '] ' + round.greetKind + ' 已送达');
            }
            else {
                log('info', '心跳问候 [' + chatId + '] ' + round.greetKind + ' 未送达（' + (round.decided ?? '无输出') + '），窗口内重试');
            }
            void saveState();
            return;
        }
        state.lastAttemptAt[chatId] = Date.now();
        if (round.decided === 'spoke') {
            state.spoke[chatId] = (state.spoke[chatId] ?? 0) + 1;
            state.lastSpokeAt[chatId] = Date.now();
            log('info', '心跳回合 [' + chatId + '] 主动开口（今日第 ' + state.spoke[chatId] + ' 次）');
        }
        else {
            log('info', '心跳回合 [' + chatId + '] 结束（' + (round.decided ?? '无输出·按沉默') + '）');
        }
        void saveState();
    }

    /** Fetch recent messages via OneBot (group or friend, read-only APIs). */
    async function fetchHistory(kind, target) {
        const count = Math.min(Math.max(Math.floor(Number(config.historyCount) || 20), 1), 50);
        const data = kind === 'private'
            ? await deps.call('get_friend_msg_history', { user_id: target, count })
            : await deps.call('get_group_msg_history', { group_id: target, count });
        return Array.isArray(data?.messages) ? data.messages : [];
    }

    /** Render the transcript lines (oldest → newest, capped): "HH:MM 昵称：文本".
     *  Also returns the speaker display names, so the bridge can strip them from
     *  the model's reply if it mimics this transcript format. */
    function formatTranscript(messages, selfId) {
        const sorted = messages.slice().sort((a, b) => (Number(a.time ?? 0) || 0) - (Number(b.time ?? 0) || 0));
        const lines = [];
        const names = new Set();
        for (const m of sorted.slice(-15)) {
            const sender = m.sender ?? {};
            const userId = String(sender.user_id ?? m.user_id ?? '');
            const name = typeof sender.card === 'string' && sender.card !== '' ? sender.card
                : typeof sender.nickname === 'string' && sender.nickname !== '' ? sender.nickname
                    : userId;
            const who = selfId !== undefined && userId === String(selfId) ? '我' : name;
            const raw = typeof m.raw_message === 'string' ? m.raw_message : '';
            if (raw.trim() === '')
                continue;
            if (who !== '我')
                names.add(name);
            const time = Number(m.time ?? 0) || 0;
            const stamp = time > 0 ? hhmm(new Date(time * 1000)) : '--:--';
            lines.push(stamp + ' ' + who + '：' + raw.slice(0, 80));
        }
        return { text: lines.join('\n'), names: [...names] };
    }

    /** Daily greeting prompts (private only): first hello of the day / pre-cutoff goodnight.
     *  与心跳提示词分开：问候不提「判断是否合适」，而是直接要求说这句。 */
    function buildGreet(kind, mins) {
        const hh = pad(Math.floor(mins / 60)) + ':' + pad(mins % 60);
        return kind === 'night'
            ? '【问候 · 晚安】现在是 ' + hh + '，学校 22:30 就要断电了。用你的方式跟主人道晚安：提醒TA趁现在保存好东西、该收尾睡觉了，顺势说晚安。一两句话，口语化，符合你的人设，直接输出内容，不要解释。这句话今天必须说到，不要输出 [SILENT] 或 [沉默]。'
            : '【问候 · 今天第一次说话】现在是 ' + hh + '，主人今天第一次来找你（可能刚开机）。按现在的时间自然打个招呼（早上就早安，下午或晚上就相应问候），可以带一句今天的期待或小撒娇。一两句话，口语化，符合你的人设，直接输出内容，不要解释。这句话今天必须说到，不要输出 [SILENT] 或 [沉默]。';
    }
    function buildPrompt(kind, target, transcript, idleMinutes) {
        // silentAllowed=false（qqchat 自 2026-10-30）：提示词不再提供「沉默」出口，
        // 情境回合必须开口；出站拦截逻辑保留（模型若仍吐 [SILENT] 照旧吞掉）。
        const silentOff = config.silentAllowed === false;
        const head = kind === 'private'
            ? [
                '【心跳 · 主动私聊判断】现在是 ' + hhmm() + '。',
                '下面是你和主人最近的私聊记录（从旧到新；"我"是你自己发过的消息）：',
                transcript !== '' ? transcript : '（最近没有可展示的文字消息）',
                '最后一条消息距今约 ' + idleMinutes + ' 分钟。',
                silentOff
                    ? '请以你的角色直接开口：主动私聊主人说点什么（分享个小见闻、想到什么有趣的、或单纯想TA了；自然一些，别硬凑）。'
                    : '请以你的角色判断：此刻主动私聊主人说点什么是否自然（分享个小见闻、想到什么有趣的、或单纯想TA了；刚聊过没多久或没什么可说就不要说，一天别刷屏）。',
                '- 适合开口：直接输出要发给主人的内容（一两句话以内、口语化、符合你的人设；不要任何解释、前缀或引号）。',
                '- 直接说话即可：**不要模仿聊天记录格式**，不要在开头加「昵称：」「我：」或时间戳。',
                silentOff
                    ? '- 必须开口：不要输出 [SILENT]、[沉默] 或任何「不说话」的表示，哪怕只是一句轻声的话也要发出去。'
                    : '- 不适合：只输出 [SILENT]，不要输出其他任何内容。',
            ]
            : [
                '【心跳 · 主动搭话判断】现在是 ' + hhmm() + '。',
                '下面是群 ' + target + ' 最近的聊天记录（从旧到新；"我"是你自己发过的消息）：',
                transcript !== '' ? transcript : '（最近没有可展示的文字消息）',
                '最后一条消息距今约 ' + idleMinutes + ' 分钟。',
                silentOff
                    ? '请以你的角色直接开口：主动说一句话（冷场接个话、分享点小见闻、吐槽一句都可以；自然一些，别硬凑）。'
                    : '请以你的角色判断：此刻主动说一句话是否自然（冷场接个话、分享点小见闻、吐槽一句都可以；大家聊得正热、或此刻开口会很突兀就不要说）。',
                '- 适合开口：直接输出要发到群里的内容（一两句话以内、口语化、符合你的人设；不要任何解释、前缀或引号）。',
                '- 直接说话即可：**不要模仿聊天记录格式**，不要在开头加「昵称：」「我：」或时间戳。',
                silentOff
                    ? '- 必须开口：不要输出 [SILENT]、[沉默] 或任何「不说话」的表示，哪怕只是一句轻声的话也要发出去。'
                    : '- 不适合：只输出 [SILENT]，不要输出其他任何内容。',
            ];
        return head.join('\n');
    }

    async function tick() {
        if (stopped || tickRunning)
            return;
        tickRunning = true;
        try {
            if (!deps.connected())
                return;
            const now = new Date();
            rollDate(now);
            if (inQuietHours(config.quietHours, now))
                return;
            for (const raw of config.chats ?? []) {
                const entry = String(raw).trim();
                const isPrivate = entry.toLowerCase().startsWith('private:');
                const idNum = Number(entry.replace(/\D/g, ''));
                if (!Number.isFinite(idNum) || idNum <= 0)
                    continue;
                const kind = isPrivate ? 'private' : 'group';
                const chatId = kind + ':' + idNum;
                try {
                    if (pending.has(chatId) || deps.chatBusy(chatId))
                        continue;
                    // 问候（私聊专属）：与心跳分开裁决——不占每日次数，不看冷却/冷场，
                    // 只看时间窗口 + 是否已真正送达；失败在窗口内重试，临近窗口末尾
                    // 不再等冷场（must-deliver）。详见 greetingDue()。
                    if (kind === 'private') {
                        state.greet ??= {};
                        const g = state.greet[chatId] ?? {};
                        const due = greetingDue(now, g);
                        if (due !== null) {
                            const atKey = due.kind === 'night' ? 'nAt' : 'mAt';
                            if (Date.now() - (Number(g[atKey]) || 0) < GREET_RETRY_MS)
                                continue;
                            // 刚聊完就插一句问候像打断：等 TA 安静 3 分钟再发；
                            // 窗口末尾（22:10 后）不再等，保证断电前送到。
                            let idleMinutes = Number.POSITIVE_INFINITY;
                            try {
                                const recent = await fetchHistory('private', idNum);
                                if (recent.length > 0) {
                                    const last = Math.max(...recent.map(m => Number(m.time ?? 0) || 0)) * 1000;
                                    if (last > 0)
                                        idleMinutes = Math.floor((Date.now() - last) / 60_000);
                                }
                            }
                            catch {
                                // 拉不到历史就照发（问候必须送达）
                            }
                            if (!due.nearEnd && idleMinutes < GREET_IDLE_MINUTES)
                                continue;
                            // 先记“尝试过”再派发：进程崩了也不会每 tick 重复轰炸；
                            // 但“当天已完成”只在 onTurnEnd 真开口后才写。
                            state.greet[chatId] = { ...g, [atKey]: Date.now() };
                            await saveState();
                            pending.set(chatId, { startedAt: Date.now(), decided: null, greetKind: due.kind });
                            log('info', '问候 [' + chatId + '] ' + due.kind + '（' + (g[atKey] ? '重试' : '首次') + '）');
                            await deps.dispatchFollowup(chatId, buildGreet(due.kind, due.mins));
                            continue;
                        }
                    }
                    const maxPerDay = Number.isFinite(Number(config.maxPerDay)) ? Number(config.maxPerDay) : 5;
                    if (maxPerDay > 0 && (state.spoke[chatId] ?? 0) >= maxPerDay)
                        continue;
                    const attemptGap = (Number(config.retryMinutes) || 30) * 60_000;
                    if (Date.now() - (state.lastAttemptAt[chatId] ?? 0) < attemptGap)
                        continue;
                    const speakGap = (Number(config.cooldownMinutes) || 120) * 60_000;
                    if (Date.now() - (state.lastSpokeAt[chatId] ?? 0) < speakGap)
                        continue;
                    const messages = await fetchHistory(kind, idNum);
                    if (messages.length === 0)
                        continue; // 从未活跃的群不唤醒（对齐 pygmalion 未激活语义）
                    const lastTime = Math.max(...messages.map(m => Number(m.time ?? 0) || 0)) * 1000;
                    const idleMinutes = Math.floor((Date.now() - lastTime) / 60_000);
                    if (idleMinutes < (Number(config.idleMinutes) || 10))
                        continue; // 群还热着，不插话
                    const transcript = formatTranscript(messages, deps.selfId());
                    // 登记发言人昵称：模型若模仿转录格式输出「昵称：…」，出站会剥离
                    deps.noteParticipants?.(chatId, transcript.names);
                    // Mark BEFORE dispatch: the async reply's outbound hits the
                    // interception regardless of when the turn actually starts.
                    pending.set(chatId, { startedAt: Date.now(), decided: null });
                    log('info', '心跳触发情境回合 [' + chatId + ']（冷场 ' + idleMinutes + ' 分钟）');
                    await deps.dispatchFollowup(chatId, buildPrompt(kind, idNum, transcript.text, idleMinutes));
                }
                catch (error) {
                    pending.delete(chatId); // a failed dispatch must not wedge the chat's interception
                    log('warn', '心跳 tick [' + chatId + '] 失败: ' + (error instanceof Error ? error.message : String(error)));
                }
            }
        }
        finally {
            tickRunning = false;
        }
    }

    return {
        start() {
            if (timer !== null)
                return;
            if (!config.enabled || (config.chats ?? []).length === 0) {
                log('info', '心跳主动搭话未启用（配置 heartbeatEnabled=true 且 heartbeatChats 非空后生效）');
                return;
            }
            void loadState();
            const tickMs = Math.max(Math.floor(Number(config.tickMs) || 60_000), 15_000);
            log('info', '心跳主动搭话已启动（tick=' + tickMs + 'ms, chats=' + (config.chats ?? []).join(',') + ', maxPerDay=' + (config.maxPerDay ?? 5) + ', quietHours=' + (config.quietHours ?? []).join(',') + '）');
            timer = setInterval(() => {
                void tick().catch((error) => {
                    log('warn', '心跳 tick 异常: ' + (error instanceof Error ? error.message : String(error)));
                });
            }, tickMs);
            timer.unref?.();
        },
        stop() {
            stopped = true;
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        },
        runOnce: tick,
        isPending,
        interceptOutbound,
        onTurnEnd,
    };
}
