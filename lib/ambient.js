/**
 * 群聊「凑热闹」判定（纯函数，便于单测）。
 *
 * 未 @ 机器人的群消息：点名（ambientNameHints）直接放行；其余按概率抽样，
 * 且同一群受冷却约束；机器人正忙时不凑。
 */
export function shouldChime({ text, hints, chance, now, lastAt, cooldownMs, busy, random = Math.random }) {
    const value = String(text ?? '');
    const named = Array.isArray(hints)
        && hints.some((hint) => typeof hint === 'string' && hint !== '' && value.includes(hint));
    // 点名优先于忙碌：被叫到就排队（与 @ 同语义），不因正忙直接丢。
    if (named)
        return { pass: true, reason: 'named' };
    if (busy === true)
        return { pass: false, reason: 'busy' };
    const cooldown = Number(cooldownMs) || 0;
    const last = Number(lastAt ?? 0);
    if (cooldown > 0 && last > 0 && now - last < cooldown)
        return { pass: false, reason: 'cooldown' };
    const probability = Number(chance);
    if (!(probability > 0))
        return { pass: false, reason: 'chance-off' };
    return random() < probability ? { pass: true, reason: 'sampled' } : { pass: false, reason: 'sampled-out' };
}
