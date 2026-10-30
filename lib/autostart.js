/**
 * 开机自启状态（插件内开关，替代早期桌面 .bat）。
 *
 * 真机启动链是「Windows 登录 → HKCU Run → bot-host.ps1 → NapCat + dsh 宿主」。
 * 看门狗在宿主加载本插件之前运行，所以它读不了 DSH 配置；本模块把开关状态
 * 落到 mediaDir/autostart.json（与运行中的插件共享同一份文件），由 bot-host.ps1
 * 在启动时读取：
 *   { "enabled": true, "updatedAt": "2026-...", "by": "dsh-onebot-qq" }
 *
 * 语义：enabled=false 只影响「下次开机是否自动拉起」，不打断当前实例。
 * 关掉后重开：在 QQ 里发 /autostart on（宿主还在跑时），或手动启动一次宿主。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const AUTOSTART_FILE = 'autostart.json';

export class AutostartState {
    /**
     * @param {{dir: string, defaultEnabled?: boolean, log?: (level: string, message: string) => void}} options
     */
    constructor({ dir, defaultEnabled = true, log = () => {} }) {
        this.dir = dir;
        this.defaultEnabled = defaultEnabled !== false;
        this.log = log;
        this.path = join(dir, AUTOSTART_FILE);
    }

    /** Current state; a missing/corrupt file falls back to the configured default. */
    get() {
        try {
            if (!existsSync(this.path))
                return { enabled: this.defaultEnabled, updatedAt: undefined, source: 'default' };
            const raw = JSON.parse(readFileSync(this.path, 'utf8'));
            return {
                enabled: raw?.enabled !== false,
                updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : undefined,
                source: 'file',
            };
        }
        catch (error) {
            this.log('warn', 'autostart 状态读取失败，按默认值处理：' + (error instanceof Error ? error.message : String(error)));
            return { enabled: this.defaultEnabled, updatedAt: undefined, source: 'default' };
        }
    }

    /** Persist a new state and return it. */
    set(enabled) {
        const state = {
            enabled: enabled === true,
            updatedAt: new Date().toISOString(),
            by: 'dsh-onebot-qq',
        };
        try {
            mkdirSync(this.dir, { recursive: true });
            writeFileSync(this.path, JSON.stringify(state, null, 2) + '\n', 'utf8');
            this.log('info', 'autostart 已设为 ' + (state.enabled ? '开启' : '关闭') + '（下次开机生效）');
            return { ...state, source: 'file' };
        }
        catch (error) {
            this.log('warn', 'autostart 状态写入失败：' + (error instanceof Error ? error.message : String(error)));
            return this.get();
        }
    }

    /** Seed the file on first mount so the watchdog has a value before the first toggle. */
    ensure() {
        if (existsSync(this.path))
            return this.get();
        return this.set(this.defaultEnabled);
    }
}
