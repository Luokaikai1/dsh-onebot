/**
 * 兴趣记忆 + 近期残影：真人式「感兴趣的记忆更深、刚聊过的有印象」。
 *
 * 两层注入（每条消息至多一行摘要，零依赖、纯本地文件 interest.json、不调模型）：
 *  1.【兴趣记忆】显式好恶 + 人设词库话题 + 每聊次数（14 天衰减）——长期的
 *  2.【最近】刚聊过的话题残影（最近 6 条用户消息，48h 过期）——边界桥。
 *    平时不出现在上下文（会话历史本身就是近期记忆）；只在丢弃边界注入一次：
 *    rollover 自动 /new 前（armRecent）、或最近消息超过 30 分钟（久隔/重启）。
 *    被问到已经丢弃的内容时，模型应按人设承认记性差（免费大米饭），不编造。
 *
 * @module dsh-onebot-qq/interest
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

/** 角色的词库：这些词出现说明聊到了我在意的事。 */
const LEXICON = ['火锅', '烤鱼', '摸头', '睡觉', '饭', '大米饭', '充电', '鲸鱼', '游戏', '猫', '表情包'];
/** 显式好恶捕获：动词 + 1~10 字对象。 */
const LIKE_RE = /(?:喜欢|爱死|爱上|讨厌|不爱|不喜欢)(?:上)?([\u4e00-\u9fa5A-Za-z0-9]{1,10})/g;
/** 对象前的动词会被并进来，剥掉一个最常见的（吃火锅 → 火锅）。 */
const MAX_TOPICS = 12;
const MAX_LIKES = 6;
const TTL_DAYS = 14;
/** 近期残影：环形缓冲长度与过期。真实会话实测 6000-token 窗口 ≈ 10-19 轮，
 * N=14 可覆盖最短会话的全部用户轮次；注入成本由展示条数（6）封顶，与 N 无关。 */
const RECENT_MAX = 14;
const RECENT_TTL_MS = 48 * 3_600_000;
/** 超过这个空闲视为「久隔」，下一条消息带一次残影。 */
const RECENT_IDLE_MS = 30 * 60_000;
const BRIEF_MAX = 260;

export class InterestMemory {
    /**
     * @param options.dir 存储目录（mediaDir）
     * @param options.log (level, message) => void
     */
    constructor({ dir, log }) {
        this.path = join(dir, 'interest.json');
        this.log = log;
        this.data = undefined;
        this.dirty = false;
    }

    async load() {
        if (this.data !== undefined)
            return this.data;
        try {
            this.data = JSON.parse(await readFile(this.path, 'utf8'));
        }
        catch {
            this.data = {};
        }
        return this.data;
    }

    async save() {
        if (!this.dirty || this.data === undefined)
            return;
        try {
            await mkdir(dirname(this.path), { recursive: true });
            await writeFile(this.path, JSON.stringify(this.data, null, 1), 'utf8');
            this.dirty = false;
        }
        catch (error) {
            this.log?.('warn', '兴趣记忆落盘失败: ' + String(error));
        }
    }

    /** 14 天没再出现的条目清掉（真人也是久不提就淡忘）。 */
    prune(now = Date.now()) {
        const ttl = TTL_DAYS * 86_400_000;
        for (const chat of Object.values(this.data)) {
            for (const key of Object.keys(chat.topics ?? {})) {
                if (now - chat.topics[key].last > ttl)
                    delete chat.topics[key];
            }
            chat.likes = (chat.likes ?? []).filter(x => now - x.last < ttl).slice(0, MAX_LIKES);
            if (chat.sulk && now - chat.sulk.since > 86_400_000)
                delete chat.sulk;
            chat.dislikes = (chat.dislikes ?? []).filter(x => now - x.last < ttl).slice(0, MAX_LIKES);
        }
    }

    /** 记录一条入站消息的兴趣信号 + 近期话题环。 */
    async record(chatId, nick, text) {
        const data = await this.load();
        const chat = data[chatId] ??= { nick: nick ?? '', msgs: 0, topics: {}, likes: [], dislikes: [], recent: [], updatedAt: 0 };
        const now = Date.now();
        chat.msgs += 1;
        if (nick !== undefined && nick !== '')
            chat.nick = nick;
        this.prune(now);
        const hit = word => {
            const topic = (chat.topics[word] ??= { n: 0, last: 0 });
            topic.n += 1;
            topic.last = now;
        };
        for (const word of LEXICON) {
            if (text.includes(word))
                hit(word);
        }
        let match;
        LIKE_RE.lastIndex = 0;
        while ((match = LIKE_RE.exec(text)) !== null) {
            const object = (match[1] ?? '').replace(/^[吃喝玩打看听]/, '');
            if (object === '')
                continue;
            const negative = /讨厌|不爱|不喜欢/.test(match[0]);
            const bucket = negative ? 'dislikes' : 'likes';
            const found = chat[bucket].find(x => x.what.includes(object) || object.includes(x.what));
            if (found !== undefined) {
                found.what = object.length >= found.what.length ? object : found.what;
                found.n += 1;
                found.last = now;
            }
            else {
                chat[bucket].push({ what: object, n: 1, last: now });
                if (chat[bucket].length > MAX_LIKES)
                    chat[bucket].sort((a, b) => b.n - a.n || b.last - a.last).splice(MAX_LIKES);
            }
        }
        const keys = Object.keys(chat.topics);
        if (keys.length > MAX_TOPICS) {
            keys
                .sort((a, b) => chat.topics[a].n - chat.topics[b].n || chat.topics[a].last - chat.topics[b].last)
                .slice(0, keys.length - MAX_TOPICS)
                .forEach(key => delete chat.topics[key]);
        }
        // 生闷气计数：被冷战的那个 TA 再说话，就多被哄一次。
        if (chat.sulk && chat.sulk.who && nick && (nick.includes(chat.sulk.who) || chat.sulk.who.includes(nick))) {
            chat.sulk.attempts = (chat.sulk.attempts ?? 0) + 1;
        }
        // 近期话题环：只记用户侧文本（模型侧回复不用记，够用且省空间）。
        const snippet = text.replace(/\s+/g, ' ').slice(0, 28);
        if (snippet !== '' && !/^\[(表情包|图片|语音|视频|文件|CQ:[^\]]+)\]$/.test(snippet)) {
            chat.recent ??= [];
            if (chat.recent.length === 0 || chat.recent[chat.recent.length - 1].x !== snippet) {
                chat.recent.push({ t: now, x: snippet });
                if (chat.recent.length > RECENT_MAX)
                    chat.recent.splice(0, chat.recent.length - RECENT_MAX);
            }
        }
        chat.updatedAt = now;
        this.dirty = true;
        await this.save();
    }

    /** 丢弃边界标记（rollover 自动 /new 前调用）：下一条消息注入一次近期残影。 */
    async armRecent(chatId) {
        const data = await this.load();
        const chat = data[chatId];
        if (chat === undefined)
            return;
        chat.recentArmed = true;
        this.dirty = true;
        await this.save();
    }

    /** 记录心情状态：sulk（生某人的气，保持沉默）或 forgive（消气）。 */
    async setMood(chatId, mood, who) {
        const data = await this.load();
        const chat = data[chatId] ??= { nick: '', msgs: 0, topics: {}, likes: [], dislikes: [], recent: [], updatedAt: 0 };
        const now = Date.now();
        if (mood === 'sulk') {
            chat.sulk = { who: String(who ?? '').slice(0, 12), since: now, attempts: 0 };
        } else if (mood === 'forgive') {
            delete chat.sulk;
        }
        chat.updatedAt = now;
        this.dirty = true;
        await this.save();
    }
    /** 一行摘要（无内容返回 ''，调用方不加）。长期兴趣 + 边界残影。
     *  异步：可能清除 armed 标记并落盘，调用方必须 await（否则写竞态会吞标记）。 */
    async brief(chatId) {
        if (this.data === undefined)
            return '';
        const chat = this.data[chatId];
        if (chat === undefined)
            return '';
        const now = Date.now();
        const recentParts = [];
        const interestParts = [];
        // —— 近期残影：只在丢弃边界（armed / 久隔）出现一次 ——
        const recent = (chat.recent ?? []).filter(e => now - e.t < RECENT_TTL_MS);
        const shownN = chat.recentShownN ?? 0;
        const idle = recent.length > 0 && now - recent[recent.length - 1].t > RECENT_IDLE_MS;
        if (recent.length >= 2 && (chat.recentArmed === true || (idle && shownN < recent.length))) {
            const items = [];
            for (const e of [...recent].reverse()) {
                if (!items.includes(e.x))
                    items.push(e.x);
                if (items.length >= 6)
                    break;
            }
            items.reverse();
            recentParts.push('【最近】刚和TA聊过：' + items.join('、') + '（细节可能已模糊）');
            chat.recentShownN = recent.length;
            chat.recentArmed = false;
            this.dirty = true;
            await this.save();
        }
        // —— 长期兴趣 ——
        if ((chat.msgs ?? 0) >= 3)
            interestParts.push('和' + ((chat.nick || '对方').slice(0, 6)) + '聊过 ' + chat.msgs + ' 次');
        const likes = (chat.likes ?? []).slice().sort((a, b) => b.n - a.n).slice(0, 2).map(x => x.what);
        if (likes.length > 0)
            interestParts.push('TA 说过喜欢 ' + likes.join('、'));
        const dislikes = (chat.dislikes ?? []).slice().sort((a, b) => b.n - a.n).slice(0, 2).map(x => x.what);
        if (dislikes.length > 0)
            interestParts.push('TA 不喜欢 ' + dislikes.join('、'));
        const tops = Object.entries(chat.topics ?? {})
            .sort((a, b) => b[1].n - a[1].n)
            .slice(0, 3)
            .map(([word, topic]) => word + '×' + topic.n);
        if (tops.length > 0)
            interestParts.push('最近常出现：' + tops.join('、'));
        if (chat.sulk) {
            recentParts.push('【心情】你在生「' + (chat.sulk.who || '某人') + '」的气：对TA保持 [沉默]，TA哄你（已被哄 ' + (chat.sulk.attempts ?? 0) + ' 次，3次左右就可以傲娇地消气并调 qq_mood 原谅）');
        }
        if (interestParts.length > 0)
            recentParts.push('【兴趣记忆】' + interestParts.join('；'));
        const parts = recentParts;
        if (parts.length === 0)
            return '';
        const line = parts.join('；');
        return line.length > BRIEF_MAX ? line.slice(0, BRIEF_MAX) : line;
    }
}
