/**
 * Outbound delivery pipeline (M2-D1-PR2): the per-chat serial send chain,
 * sendToChat (sensitive audit → [[qq_forward]] blocks → t2i card / plain
 * text), raw OneBot segment sends, merged forwards, and the M1-B6 offline
 * resend queue (per-chat FIFO, cap 20, TTL 5 min, drained on reconnect).
 * Extracted verbatim from bridge.ts — send order, queueing, TTL/cap and
 * fallback behavior are byte-identical; the bridge keeps same-name facade
 * methods so tools.ts, the command table and the interim domain (still
 * bridge-resident) keep working unchanged.
 * @module dsh-onebot/outbound
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitChatId } from './chat.js';
import { OneBotActionError, OneBotNotConnectedError } from './connection.js';
import { extractForwardBlocks, scanSensitive, stripMarkdown } from './split.js';
import { renderTextImage } from './t2i/index.js';
import { describeError } from './errors.js';
import { TRACE_REASONS } from './trace.js';
/** Queued final replies older than this are dropped at drain time (M1-B6). */
const PENDING_SEND_TTL_MS = 5 * 60_000;
/** Max queued final replies per chat; the oldest is dropped beyond this (M1-B6). */
const PENDING_SEND_MAX = 20;

/**
 * Models often mimic the inbound "[HH:MM 昵称(QQ)]" prefix and answer with
 * "[12:28] 我：…" or "迷途不知返：…". Strip that leading transcript metadata
 * (time stamp, known speaker name, self name) so the outgoing message reads
 * like a person typing, not a chat log.
 */
const REPLY_TIME_PREFIX = /^\s*[[［]\s*\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*[^\]］]*[\]］]\s*(?:我|大肥鱼)?\s*[:：]?\s*/u;
const REPLY_SELF_PREFIX = /^\s*(?:我|大肥鱼)\s*[:：]\s*/u;
/**
 * 催促信号：只有用户确实在催（催/急/快点/咋不回…）时，「大肥鱼脑袋转不动啦，
 * 要充点电~」才像真人撒娇；没被催时它只是模型学来的开场白，换成自然的
 * 思考提示语（"让我先想想哈~"这类）。
 */
export const URGE_HINT = /催|急|快点|快些|赶紧|咋不回|怎么不回|还不回|回了没|好了没|在吗|在不在|等你|等了|等很?久|太慢|好慢/u;
const TIRED_PHRASE = /大肥鱼脑袋转不动(?:啦|了)?\s*[，,~～]?\s*(?:要)?充点电[~～]?/u;
const THINKING_FILLERS = ['让我先想想哈~', '等我捋一下哈~', '我理理，稍等一下~'];
/** 这条用户消息是否在催（bridge 按回合记录，出站时据此决定是否保留人设占位句）。 */
export function isUrging(text) {
    return typeof text === 'string' && URGE_HINT.test(text);
}
/** 剥离前置的已知发言人昵称（模型模仿心跳转录的「昵称：内容」格式）。 */
function stripSpeakerPrefix(text, knownNames) {
    if (typeof text !== 'string' || !Array.isArray(knownNames) || knownNames.length === 0)
        return text;
    for (const name of knownNames) {
        if (typeof name !== 'string' || name.trim() === '')
            continue;
        const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('^\\s*' + escaped + '\\s*[:：]\\s*', 'u');
        if (re.test(text))
            return text.replace(re, '');
    }
    return text;
}
/** 没被催时把人设占位句换成自然思考提示；被催时保留原句。 */
function softenTiredPhrase(text, urged) {
    if (typeof text !== 'string' || urged === true || !TIRED_PHRASE.test(text))
        return text;
    const filler = THINKING_FILLERS[Math.floor(Math.random() * THINKING_FILLERS.length)];
    const out = text.replace(TIRED_PHRASE, filler).trim();
    return out === '' ? filler : out;
}
/**
 * 出站兜底清洗：小模型偶尔把「助理腔 / 元信息」发进聊天正文——以「注意：」
 * 开头的说明段、报「已自动检索到表情包/图片」的段落、复述进来的「（语音转写：…）」
 * 与「（你看到的画面：…）」。这些都是对用户无意义的噪声。
 */
export function stripAssistantMeta(text) {
    if (typeof text !== 'string' || text === '')
        return text;
    let out = text
        .replace(/^\s*(大肥鱼|本鱼)\s*[:：]\s*/u, '')
        .replace(/\[@[^\]\n]{0,24}\]/gu, '')
        .replace(/（语音转写：[^）]*）/gu, '')
        .replace(/（你看到的画面：[^）]*）/gu, '')
        .replace(/^\s*-{3,}\s*$/gmu, '')
        .replace(/\u{1F916}/gu, '')
        // 去掉 [@我] 之类的标记后常留下「，！」这种悬空标点
        .replace(/[，,]\s*([！？。!?])/gu, '$1');
    const kept = out.split(/\n{2,}/u).filter((para) => {
        const t = para.trim();
        if (t === '')
            return false;
        if (/^注意[:：]/u.test(t))
            return false;
        if (/已自动(检索|识别)到/u.test(t))
            return false;
        if (/如果您希望.*(图片|表情包)/u.test(t))
            return false;
        // 客服腔收尾：7B 模型很容易退化成「您好／有什么可以帮助您的／有话题直接告诉我」
        if (/有什么可以(帮助|帮)(您|你)/u.test(t))
            return false;
        if (/需要讨论的话题/u.test(t))
            return false;
        if (/(特定|其他|什么)(的)?问题.*告诉我/u.test(t))
            return false;
        return true;
    });
    out = kept.join('\n\n').trim();
    return out;
}

/** 分段发送：模型用空行分成两段的回复，拆成两条消息发出去（更像真人连发）。
 *  任一段偏长（>200 字）时保持整条，避免把长内容切碎。 */
export function splitChatParagraphs(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed === '')
        return [];
    const parts = trimmed.split(/\n{2,}/u).map(part => part.trim()).filter(Boolean);
    if (parts.length < 2)
        return [trimmed];
    if (parts.some(part => part.length > 200))
        return [trimmed];
    return parts;
}

export function stripReplyPrefix(text, knownNames, urged) {
    if (typeof text !== 'string')
        return text;
    let out = text.replace(REPLY_TIME_PREFIX, '');
    out = stripSpeakerPrefix(out, knownNames);
    out = out.replace(REPLY_SELF_PREFIX, '');
    return softenTiredPhrase(out, urged);
}
/** 催促有效窗口：一条催促消息之后这段时间内，占位句仍算自然。 */
const URGE_WINDOW_MS = 15 * 60_000;
/** W2-③: default bridge-wide proactive-write caps, aligned with the MIT
 * competitor's actionRatePerMinute(20) / actionRatePerDay(500). */
export const DEFAULT_ACTION_RATE_PER_MINUTE = 20;
export const DEFAULT_ACTION_RATE_PER_DAY = 500;
/** W2-③: proactive-write audit file name, appended under mediaDir (jsonl). */
export const ACTION_AUDIT_FILE = 'qq-actions.log';
/**
 * The outbound pipeline. Owns the B6 pendingSends state; the bridge keeps
 * same-name delegating facades and wires the reconnect drain trigger.
 */
export class OutboundPipeline {
    ctx;
    /** Clock override (tests); behavior-affecting timestamps (send chains,
     * offline queue, write gate) all read it — never the wall clock directly. */
    now;
    /** Per-chat FIFO of model final replies parked while disconnected; drained
     * oldest-first on reconnect (M1-B6). */
    pendingSends = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        // Lazy default: read Date.now through a wrapper so an injected clock is
        // optional and callers without one keep the dynamic global lookup (fake
        // timers in tests must keep influencing the wall-clock path).
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * Send plain text to a chat with the full outbound pipeline (forward
     * blocks, Markdown strip, sentence splitting).
     * @param chatId - target chat.
     * @param text - model-produced text.
     * @param options - optional reply target.
     * @returns the sent message ids.
     */
    sendToChat(chatId, text, options = {}) {
        // 出站清洗：剥离[时间]/「我：」/已知发言人昵称前缀；用户没在催时把
        // 「大肥鱼脑袋转不动啦，要充点电~」换成自然的思考提示。
        const chat = this.ctx.getChat(chatId);
        const knownNames = chat?.knownNames instanceof Set
            ? [...chat.knownNames]
            : Array.isArray(chat?.knownNames) ? chat.knownNames : undefined;
        const urgedAt = typeof chat?.lastUserUrgedAt === 'number' ? chat.lastUserUrgedAt : undefined;
        const urged = urgedAt !== undefined && this.now() - urgedAt < URGE_WINDOW_MS;
        text = stripReplyPrefix(text, knownNames, urged);
        return this.enqueue(chatId, async () => {
            if (!this.ctx.connected()) {
                if (options.queuable === true) {
                    // pipeline-hooks.md #23: the park used to be silent.
                    this.ctx.log('debug', '连接断开，回复已排队等待重连补发: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: true, reason: TRACE_REASONS.outboundQueued });
                    this.queuePendingSend(chatId, text);
                    return [];
                }
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundNotConnected });
                throw new OneBotNotConnectedError();
            }
            const hits = scanSensitive(text, this.ctx.config.sensitivePatterns);
            if (hits.length > 0) {
                this.ctx.log('warn', 'sensitive outbound audit for ' + chatId + ': ' + hits.join(', '));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: TRACE_REASONS.outboundSensitive, data: { hits: hits.slice(0, 5) } });
            }
            const ids = [];
            const { body, nodes } = extractForwardBlocks(text, '助手');
            if (nodes.length > 0) {
                // Passive reply path: [[qq_forward]] blocks inside a turn reply are
                // NOT gated as proactive writes (see the W2-③ 口径 note).
                await this.sendForwardNodes(chatId, nodes);
                ids.push('forward');
            }
            let sentCard = false;
            const threshold = this.ctx.config.textImageThreshold;
            if (threshold > 0 && body.length > threshold) {
                try {
                    const chat = this.ctx.getChat(chatId);
                    const title = chat !== undefined && chat.lastNickname !== ''
                        ? 'To ' + chat.lastNickname
                        : undefined;
                    const png = renderTextImage(body, {
                        title,
                        footerBrand: this.ctx.config.cardFooter,
                        fontFiles: this.ctx.config.fontFiles,
                        fontFamilies: this.ctx.config.fontFamilies,
                    });
                    const b64 = 'base64://' + png.toString('base64');
                    if (b64.length <= this.ctx.config.maxImageBytes) {
                        const id = await this.sendMsg(chatId, [{ type: 'image', data: { file: b64 } }], options);
                        if (id !== undefined)
                            ids.push(id);
                        sentCard = true;
                    }
                    else {
                        this.ctx.log('warn', 't2i card PNG exceeds maxImageBytes; falling back to text');
                        this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundCardTooLarge });
                    }
                }
                catch (error) {
                    this.ctx.log('warn', 't2i render failed, falling back to text: ' + describeError(error));
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '文字图卡片渲染失败，已降级为文本: ' + describeError(error) });
                }
            }
            if (!sentCard) {
                const plain = stripMarkdown(body);
                const parts = splitChatParagraphs(plain);
                if (parts.length > 0) {
                    for (const part of parts) {
                        const id = await this.sendMsg(chatId, [{ type: 'text', data: { text: part } }], options);
                        if (id !== undefined)
                            ids.push(id);
                    }
                }
                else {
                    // pipeline-hooks.md #30: the empty-body skip used to be silent.
                    this.ctx.log('debug', '正文为空，未发送: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: TRACE_REASONS.outboundEmptyText });
                }
            }
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: true, reason: '回复已发送', data: { segments: ids.length } });
            return ids;
        });
    }
    /** Park one queuable send for a chat while disconnected (M1-B6):
     * per-chat FIFO, capped — the oldest entry is dropped beyond the cap. */
    queuePendingSend(chatId, text) {
        const queue = this.pendingSends.get(chatId) ?? [];
        if (queue.length >= PENDING_SEND_MAX) {
            queue.shift();
            this.ctx.log('warn', 'pending send queue full for ' + chatId + ', dropped oldest');
            this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueFull });
        }
        queue.push({ text, sentAt: this.now() });
        this.pendingSends.set(chatId, queue);
    }
    // ── W2-③ proactive-write gate (minute/day caps + audit) ─────────────────
    // 口径（per outbound.ts structure）：「主动写」= 模型/命令经 qq_* 工具发起、
    // 不属于某个入站回合回复链的出站写 —— 即 sendSegments（qq_send_image/voice/
    // video/file/segments）与公开 sendForward（qq_send_forward）。被动回复不受此
    // 闸：sendToChat 整条链（最终回复/interim/错误与命令通知、[[qq_forward]] 块，
    // 后者走未设闸的 sendForwardNodes）由入站 rateLimitPerMinute + B6 队列上限
    // 约束。两类计数都是全桥合计（不分会话）。
    /** Sliding-60s timestamps of allowed proactive writes (bridge-wide). */
    writeActionTimes = [];
    /** Calendar-day (local) counter of allowed proactive writes. */
    writeDayKey = '';
    writeDayCount = 0;
    /** Serialized audit-append chain (order discipline, see auditWrite). */
    auditChain = Promise.resolve();
    /** W1/T5 health snapshot: the write gate's current usage against its
     * limits (minute sliding window pruned at read time; day counter). */
    writeGateStats() {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        const now = this.now();
        const minuteUsed = perMinute > 0
            ? this.writeActionTimes.filter(t => now - t < 60_000).length
            : 0;
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const dayUsed = perDay > 0 && this.writeDayKey === dayKey ? this.writeDayCount : 0;
        return { minuteUsed, minuteLimit: perMinute, dayUsed, dayLimit: perDay };
    }
    /** W2-③: check + consume one proactive-write slot. Returns a non-empty
     * Chinese rejection reason when the write must be dropped (a warn with the
     * chatId and the limit name is logged and the rejection is audited);
     * returns null when allowed (slot consumed). Rejected attempts do not
     * consume quota. */
    writeGateRejectReason(chatId, action) {
        const perMinute = this.ctx.config.actionRatePerMinute ?? DEFAULT_ACTION_RATE_PER_MINUTE;
        const perDay = this.ctx.config.actionRatePerDay ?? DEFAULT_ACTION_RATE_PER_DAY;
        if (perMinute <= 0 && perDay <= 0)
            return null;
        const now = this.now();
        this.writeActionTimes = this.writeActionTimes.filter(t => now - t < 60_000);
        const d = new Date(now);
        const dayKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        if (this.writeDayKey !== dayKey) {
            this.writeDayKey = dayKey;
            this.writeDayCount = 0;
        }
        if (perMinute > 0 && this.writeActionTimes.length >= perMinute) {
            const reason = '写操作频率超限：60 秒内主动写已达 ' + perMinute + ' 次上限（actionRatePerMinute=' + perMinute + '），请稍后再试';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        if (perDay > 0 && this.writeDayCount >= perDay) {
            const reason = '写操作次数超限：今日主动写已达 ' + perDay + ' 次上限（actionRatePerDay=' + perDay + '），明日自动恢复';
            this.ctx.log('warn', '已拒发主动写操作: chat=' + chatId + ' action=' + action + '，' + reason);
            this.auditWrite(chatId, action, false, reason);
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason });
            return reason;
        }
        this.writeActionTimes.push(now);
        this.writeDayCount += 1;
        return null;
    }
    /** W2-③: append one proactive-write (or rejection / send failure) audit
     * line to mediaDir/qq-actions.log (jsonl: ts/chatId/action/ok/reason).
     * Fire-and-forget: a write failure only warns and never affects the send
     * path. Writes are chained so lines land in call order even when the fs
     * thread pool completes them out of schedule. No-op when auditing is
     * disabled or no mediaDir is configured. */
    auditWrite(chatId, action, ok, reason) {
        if (this.ctx.config.actionAuditEnabled === false)
            return;
        const dir = this.ctx.config.mediaDir;
        if (dir === undefined || dir === '')
            return;
        const line = JSON.stringify({ ts: this.now(), chatId, action, ok, reason }) + '\n';
        this.auditChain = this.auditChain.then(async () => {
            await mkdir(dir, { recursive: true });
            await appendFile(join(dir, ACTION_AUDIT_FILE), line, 'utf8');
        }).catch(error => {
            this.ctx.log('warn', '写操作审计写入失败: ' + describeError(error));
        });
    }
    /** Resend parked final replies oldest-first after a reconnect (M1-B6).
     * Per-chat send chains keep the order; a send that hits a fresh
     * disconnection re-queues itself via the queuable gate. Expired entries
     * (TTL) are dropped. Never runs while stopping. Wired from the bridge's
     * onStatus(true) handler (bridge.start). */
    drainPendingSends() {
        if (this.ctx.isStopping())
            return;
        const now = this.now();
        const batch = [];
        for (const [chatId, queue] of this.pendingSends) {
            this.pendingSends.delete(chatId);
            for (const item of queue) {
                if (now - item.sentAt < PENDING_SEND_TTL_MS) {
                    batch.push({ chatId, text: item.text });
                }
                else {
                    // pipeline-hooks.md #25: the TTL drop used to be silent.
                    this.ctx.log('debug', '排队回复超过 5 分钟未送达，已丢弃: ' + chatId);
                    this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: TRACE_REASONS.queueTtlExpired });
                }
            }
        }
        for (const { chatId, text } of batch) {
            void this.sendToChat(chatId, text, { queuable: true }).catch((error) => {
                this.ctx.log('warn', 'queued resend failed: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'queue', ok: false, reason: '排队回复补发失败: ' + describeError(error) });
            });
        }
    }
    /**
     * Send raw OneBot segments (used by the media tools). W2-③: counts as a
     * proactive write — subject to the minute/day caps and audited.
     * @param chatId - target chat.
     * @param segments - outbound segments.
     * @returns the sent message id.
     */
    sendSegments(chatId, segments) {
        return this.enqueue(chatId, async () => {
            const reject = this.writeGateRejectReason(chatId, 'send_msg');
            if (reject !== null)
                throw new OneBotActionError(reject);
            try {
                const id = await this.sendMsg(chatId, segments, {});
                this.auditWrite(chatId, 'send_msg', true, '发送成功');
                return id;
            }
            catch (error) {
                this.auditWrite(chatId, 'send_msg', false, '发送失败: ' + describeError(error));
                this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
                throw error;
            }
        });
    }
    /** B8d: per-chat send chains owned by the pipeline (decoupled from the
     * registry's chat lifecycle — unregistered chats serialize too, the
     * original C6b ask). Entries clean themselves up once settled so evicted
     * chats do not accumulate. */
    sendChains = new Map();
    /** Serialize work on one chat's send chain. */
    enqueue(chatId, work) {
        const chain = this.sendChains.get(chatId) ?? Promise.resolve();
        const run = chain.then(work, work);
        const tail = run.catch(() => undefined);
        this.sendChains.set(chatId, tail);
        void tail.then(() => {
            if (this.sendChains.get(chatId) === tail)
                this.sendChains.delete(chatId);
        });
        return run;
    }
    /** The chat's send-chain tail; resolves once every queued send has settled
     * (settleLoop snapshots the interim trail after it, preserving order). */
    chainTail(chatId) {
        return this.sendChains.get(chatId) ?? Promise.resolve();
    }
    /** Send one message to a chat and return its message id. */
    async sendMsg(chatId, segments, options) {
        const ref = splitChatId(chatId);
        const params = {};
        let target;
        try {
            target = Number(ref.target);
            if (!Number.isFinite(target))
                throw new Error('bad target');
        }
        catch {
            throw new OneBotActionError('invalid chat target: ' + chatId);
        }
        if (ref.kind === 'group')
            params.group_id = target;
        else
            params.user_id = target;
        params.message = segments;
        if (options.replyTo !== undefined) {
            params.message = [{ type: 'reply', data: { id: options.replyTo } }, ...segments];
        }
        const data = await this.ctx.call('send_msg', params, chatId);
        return data.message_id !== undefined ? String(data.message_id) : undefined;
    }
    /** Send [[qq_forward]] nodes as a merged-forward message (proactive write
     * from the qq_send_forward tool). W2-③: subject to the minute/day caps
     * and audited; the passive [[qq_forward]] blocks inside sendToChat bypass
     * this gate via sendForwardNodes. */
    async sendForward(chatId, nodes) {
        const reject = this.writeGateRejectReason(chatId, 'send_forward_msg');
        if (reject !== null)
            throw new OneBotActionError(reject);
        try {
            await this.sendForwardNodes(chatId, nodes);
            this.auditWrite(chatId, 'send_forward_msg', true, '发送成功');
        }
        catch (error) {
            this.auditWrite(chatId, 'send_forward_msg', false, '发送失败: ' + describeError(error));
            this.ctx.trace?.(chatId, { stage: 'outbound', ok: false, reason: '主动写发送失败: ' + describeError(error) });
            throw error;
        }
    }
    /** Ungated merged-forward send (shared by the gated tool path and the
     * passive [[qq_forward]] blocks inside sendToChat). */
    async sendForwardNodes(chatId, nodes) {
        const ref = splitChatId(chatId);
        const target = Number(ref.target);
        if (!Number.isFinite(target))
            throw new OneBotActionError('invalid chat target: ' + chatId);
        const messages = nodes.map(node => ({
            type: 'node',
            data: {
                uin: this.ctx.selfId() || this.ctx.config.botQQ,
                name: node.name.slice(0, 24),
                content: [{ type: 'text', data: { text: node.content.slice(0, 500) } }],
            },
        }));
        if (ref.kind === 'group') {
            await this.ctx.call('send_forward_msg', { group_id: target, messages }, chatId);
        }
        else {
            await this.ctx.call('send_private_forward_msg', { user_id: target, messages }, chatId);
        }
    }
}
