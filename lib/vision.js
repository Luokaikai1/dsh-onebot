/**
 * 图片转述（给没有视觉能力的主模型「装眼睛」）。
 *
 * 主模型（如 qwen2.5:7b）看不到图，入站图片只能得到一个本地路径占位符。
 * 这里先用一个视觉模型把图看一遍、转成一小段中文描述，再由入站管线把描述
 * 贴在占位符后面，主模型据此作答。
 *
 * 两条路由：
 *  - cloud：OpenAI 兼容的视觉接口（默认智谱 glm-4.6V-Flash，免费），不占显存；
 *  - local：本机 Ollama 的多模态模型（默认 qwen2.5vl:3b），用完立刻卸载
 *    （keep_alive=0），隐私图片不出本机。
 * auto 模式先试云端、失败回落本地；两边都不可用时返回 ''，占位符原样保留。
 *
 * @module dsh-onebot-qq/vision
 */

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const DEFAULT_PROMPT = [
  '用一段简体中文描述这张图片，供看不见图片的聊天机器人理解。',
  '要求：先一句话说清画面主体，再补充关键细节（人物表情动作、场景、颜色、数量）；',
  '图中有文字就逐条抄出；不要 Markdown、不要分点、不要客套，控制在 200 字以内。',
].join('');

/** 图片扩展名 → MIME。 */
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/**
 * 从 credentials 文件里取 refs 中的键值（宿主把密钥放在这里，用于进程启动时
 * 注入环境变量；插件进程内直接读文件是没拿到 env 时的兜底）。
 * @param name 环境变量名
 * @returns 密钥或 undefined
 */
async function readCredentialRef(name) {
  try {
    const path = process.env.DSH_CREDENTIALS_FILE
      ?? `${process.env.USERPROFILE ?? process.env.HOME ?? ''}/.dsh/.credentials.yaml`;
    const text = await readFile(path, 'utf8');
    const line = text.split(/\r?\n/).find(row => row.trimStart().startsWith(`${name}:`));
    if (line === undefined)
      return undefined;
    const value = line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
    return value === '' ? undefined : value;
  }
  catch {
    return undefined;
  }
}

/** 描述结果裁到合理长度，去掉模型爱加的 Markdown 包裹。 */
function tidy(text, maxChars) {
  const flat = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxChars)
    return flat;
  return flat.slice(0, maxChars).trim() + '…';
}

export class VisionDescriber {
  /**
   * @param options.config 插件配置（visionMode / visionCloudModel / ...）
   * @param options.log (level, message) => void
   */
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.cache = new Map();
    this.inflight = new Map();
    this.lastRoute = undefined;
    this.lastError = undefined;
  }

  /** 是否配置成可用（off = 不转述）。 */
  get enabled() {
    return this.config.visionMode !== 'off';
  }

  async cloudKey() {
    const name = this.config.visionCloudApiKeyEnv;
    const fromEnv = name === '' ? undefined : process.env[name];
    if (fromEnv !== undefined && fromEnv !== '')
      return fromEnv;
    return name === '' ? undefined : readCredentialRef(name);
  }

  /**
   * 转述一张图。失败返回 ''（调用方保留占位符原文），绝不抛给入站管线。
   * @param path 本地图片绝对路径
   */
  async describe(path) {
    if (!this.enabled || typeof path !== 'string' || path === '')
      return '';
    const cached = this.cache.get(path);
    if (cached !== undefined)
      return cached;
    const running = this.inflight.get(path);
    if (running !== undefined)
      return running;
    const task = this.describeOnce(path)
      .catch((error) => {
        this.lastError = String(error);
        this.log('warn', 'vision describe failed: ' + String(error));
        return '';
      })
      .finally(() => this.inflight.delete(path));
    this.inflight.set(path, task);
    return task;
  }

  async describeOnce(path) {
    let info;
    try {
      info = await stat(path);
    }
    catch {
      return '';
    }
    if (!info.isFile())
      return '';
    const bytes = await readFile(path);
    const mime = MIME[extname(path).toLowerCase()] ?? 'image/jpeg';
    const prompt = this.config.visionPrompt === '' ? DEFAULT_PROMPT : this.config.visionPrompt;
    const mode = this.config.visionMode;
    let text = '';
    if (mode === 'cloud' || mode === 'auto') {
      const key = await this.cloudKey();
      if (key !== undefined) {
        text = await this.cloud(bytes.toString('base64'), mime, prompt, key).catch((error) => {
          this.lastError = 'cloud: ' + String(error);
          this.log('warn', 'vision cloud failed: ' + String(error));
          return '';
        });
        if (text !== '')
          this.lastRoute = 'cloud';
      }
      else if (mode === 'cloud') {
        this.lastError = 'cloud: no api key';
        this.log('warn', 'vision 云端模式但没有 visionCloudApiKeyEnv 对应的密钥');
      }
    }
    if (text === '' && (mode === 'local' || mode === 'auto')) {
      text = await this.local(bytes.toString('base64'), prompt).catch((error) => {
        this.lastError = 'local: ' + String(error);
        this.log('warn', 'vision local failed: ' + String(error));
        return '';
      });
      if (text !== '')
        this.lastRoute = 'local';
    }
    const result = tidy(text, this.config.visionMaxChars);
    if (result !== '')
      this.cache.set(path, result);
    return result;
  }

  /** OpenAI 兼容的视觉调用（智谱 glm-4.6V-Flash 走这条）。 */
  async cloud(base64, mime, prompt, key) {
    const url = this.config.visionCloudBaseURL.replace(/\/+$/, '') + '/chat/completions';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: this.config.visionCloudModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(this.config.visionTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    const body = await response.json();
    return body?.choices?.[0]?.message?.content ?? '';
  }

  /** 本机 Ollama 的多模态调用；keep_alive 让模型看完按配置退出显存。 */
  async local(base64, prompt) {
    const url = this.config.visionLocalBaseURL.replace(/\/+$/, '') + '/api/chat';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.config.visionLocalModel,
        messages: [{ role: 'user', content: prompt, images: [base64] }],
        stream: false,
        keep_alive: this.config.visionLocalKeepAlive,
        options: { temperature: 0.2, num_predict: 320 },
      }),
      signal: AbortSignal.timeout(this.config.visionTimeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
    }
    const body = await response.json();
    return body?.message?.content ?? '';
  }
}

export { DEFAULT_PROMPT };