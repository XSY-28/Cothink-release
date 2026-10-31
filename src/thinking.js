/** Shared product levels; these are API values, not a token/time budget. */
export const THINKING_LEVELS = Object.freeze(['low', 'high', 'max']);
export const DEFAULT_THINKING_LEVEL = 'high';
export function parseThinkingLevel(value) {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!THINKING_LEVELS.includes(level)) throw new Error('思考强度只接受 low、high、max（低／中／高）。');
  return level;
}
export function thinkingLabel(level) {
  if (level == null) return '不可用';
  return ['低', '中', '高'][THINKING_LEVELS.indexOf(parseThinkingLevel(level))];
}
function profileSupport(profile, role) {
  if (profile?.supportsThinkingLevels !== undefined) {
    if (typeof profile.supportsThinkingLevels !== 'boolean') throw new Error(`${role}.supportsThinkingLevels 必须是布尔值。`);
    return { supported: profile.supportsThinkingLevels, source: 'declared', reason: `${role} 用户能力声明${profile.supportsThinkingLevels ? '支持' : '不支持'}（未经真实服务验证）` };
  }
  let official = false;
  try {
    const url = new URL(profile?.baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.search && !url.hash) {
      official = (['api.moonshot.cn','api.moonshot.ai'].includes(url.hostname) && path === '/v1' && profile.model === 'kimi-k3') ||
        (url.hostname === 'api.deepseek.com' && ['', '/v1'].includes(path) && profile.model === 'deepseek-flash');
    }
  } catch { /* Unconfirmed profiles keep generic compatibility. */ }
  return { supported: official, source: official ? 'official' : 'unconfirmed', reason: `${role} ${official ? '符合已核对官方规则' : '未确认支持统一思考档位'}` };
}
export function getThinkingSupport(config) {
  const main = profileSupport(config?.main, 'main');
  const reviewer = profileSupport(config?.reviewer, 'reviewer');
  return { available: main.supported && reviewer.supported, main, reviewer };
}
export function resolveThinkingLevel({ explicit, saved, config }) {
  const choice = explicit !== undefined ? parseThinkingLevel(explicit) : saved !== undefined ? parseThinkingLevel(saved) : undefined;
  const support = getThinkingSupport(config);
  if (choice !== undefined && !support.available) throw new Error(`统一思考档位不可用：${['main','reviewer'].filter(role => !support[role].supported).map(role => support[role].reason).join('；')}。`);
  return choice ?? (support.available ? DEFAULT_THINKING_LEVEL : null);
}

/** Pi models advertise their own supported values; no global alias/clamping. */
export async function validateModelThinking(model, level) {
  const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/models');
  const supported = getSupportedThinkingLevels(model);
  if (level !== undefined && !supported.includes(level)) throw new Error(`${model.provider}/${model.id} 不支持思考档位 ${level}；可用：${supported.join(', ')}。`);
  return supported;
}

/** Preserve explicit choices; never let the SDK silently clamp our default. */
export async function resolveModelThinking(model, explicit) {
  const level = explicit ?? (model.reasoning ? DEFAULT_THINKING_LEVEL : 'off');
  await validateModelThinking(model, level);
  return level;
}
