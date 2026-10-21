import { getNativeClipboard } from '@earendil-works/pi-tui';

function clipboardError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function createClipboardWriter({
  getClipboard = getNativeClipboard,
  platform = process.platform,
  env = process.env,
} = {}) {
  let pending = Promise.resolve();
  return function copyText(text) {
    const result = pending.then(async () => {
      if (platform !== 'darwin' && platform !== 'win32') {
        throw clipboardError('CLIPBOARD_PLATFORM', '当前平台暂不支持自动复制');
      }
      if (env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION) {
        throw clipboardError('CLIPBOARD_REMOTE', '暂不支持远程会话自动复制');
      }
      let clipboard;
      let setText;
      try {
        clipboard = getClipboard();
        setText = clipboard?.setText;
        if (typeof setText !== 'function') throw new Error();
      } catch {
        throw clipboardError('CLIPBOARD_UNAVAILABLE', '当前环境无法自动复制到系统剪贴板');
      }
      try {
        await setText.call(clipboard, text);
      } catch {
        throw clipboardError('CLIPBOARD_WRITE', '复制失败：无法写入本机剪贴板');
      }
    });
    // Recover the internal chain while preserving the caller's own rejection.
    pending = result.catch(() => {});
    return result;
  };
}
