import { SelectList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { LoginDialogComponent } from "@earendil-works/pi-coding-agent";
import { safeText } from "./terminal.js";

/** Native masked input, with its input buffer cleared on every exit. */
export async function promptSecret(ui, field) {
  if (field.signal?.aborted) return undefined;
  return ui.custom((tui, _theme, _keys, done) => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      field.signal?.removeEventListener("abort", abort);
      dialog.input.setValue("");
      done(value);
    };
    const dialog = new LoginDialogComponent(tui, "CoThink", () => finish(undefined), undefined, "配置认证 · 输入内容不会显示");
    const abort = () => dialog.cancel();
    dialog.dispose = () => {
      field.signal?.removeEventListener("abort", abort);
      dialog.input.setValue("");
      if (!settled) dialog.cancel();
    };
    dialog.showPrompt(safeText(field.message ?? "API key"), undefined, true).then(finish, () => finish(undefined));
    field.signal?.addEventListener("abort", abort, { once: true });
    if (field.signal?.aborted) queueMicrotask(abort);
    return dialog;
  });
}

/** A viewport for CoThink management lists; values stay independent of displayed text. */
export function selectOption(ui, title, options) {
  const values = [...options];
  return ui.custom((tui, theme, keys, done) => {
    const items = values.map((value, index) => ({ value: String(index), label: safeText(value) }));
    let list, capacity = 0, headerRows = 0, itemRows = 0, width = 80, closed = false;
    const height = () => Math.max(1, tui.terminal.rows - 2);
    const selectedIndex = () => Number(list?.getSelectedItem()?.value ?? 0);
    const finish = value => {
      if (closed) return;
      closed = true;
      done(value);
    };
    const listTheme = {
      selectedPrefix: text => theme.fg("accent", text),
      selectedText: text => theme.fg("accent", text),
      description: text => theme.fg("muted", text),
      scrollInfo: text => theme.fg("muted", text),
      noMatch: text => theme.fg("muted", text),
    };
    const component = {
      invalidate() { list?.invalidate(); },
      render(columns) {
        width = Math.max(1, columns);
        if (height() < 4 || width < 10)
          return [truncateToWidth("请放大窗口；Esc 取消", width, "…")];
        const heading = new Text(safeText(title), 0, 0).render(width);
        const shownHeading = heading.slice(0, Math.min(2, height() - 3));
        if (shownHeading.length < heading.length) {
          const last = shownHeading.length - 1;
          shownHeading[last] = truncateToWidth(shownHeading[last], width - 1, "") + "…";
        }
        headerRows = shownHeading.length;
        // Reserve one line each for position and controls, even at 40×12.
        const nextCapacity = Math.max(1, height() - headerRows - 2);
        if (!list || nextCapacity !== capacity) {
          const index = selectedIndex();
          capacity = nextCapacity;
          list = new SelectList(items, capacity, listTheme);
          list.setSelectedIndex(index);
          list.onSelect = item => finish(values[Number(item.value)]);
          list.onCancel = () => finish(undefined);
        }
        itemRows = Math.min(capacity, items.length);
        const body = items.length ? list.render(Math.max(4, width)) : ["没有可选项"];
        return [
          ...shownHeading.map(line => theme.fg("accent", theme.bold(line))),
          ...body,
          theme.fg("muted", "↑↓/滚轮移动 · Enter确认 · Esc取消"),
        ].map(line => truncateToWidth(line, width, "…"));
      },
      handleInput(data) {
        if (closed) return;
        if (keys.matches(data, "tui.select.cancel")) { finish(undefined); return; }
        if (height() < 4 || width < 10) return;
        component.render(width);
        const index = selectedIndex();
        let next;
        if (keys.matches(data, "tui.select.up") || data === "k") next = index - 1;
        else if (keys.matches(data, "tui.select.down") || data === "j") next = index + 1;
        else if (matchesKey(data, "pageUp")) next = index - capacity;
        else if (matchesKey(data, "pageDown")) next = index + capacity;
        else if (matchesKey(data, "home")) next = 0;
        else if (matchesKey(data, "end")) next = items.length - 1;
        if (next !== undefined) list.setSelectedIndex(next);
        else list.handleInput(data);
        if (!closed) tui.requestRender();
      },
      handleMouse(event) {
        if (closed || height() < 4 || width < 10) return { handled: true, render: false };
        if (!list) component.render(width);
        // Wheel anywhere in the popup moves the selection; clicks only target item rows.
        if (event.type !== "wheel" && (event.y < headerRows || event.y >= headerRows + itemRows))
          return { handled: true, render: false };
        const result = list.handleMouse({ ...event, y: event.y - headerRows });
        if (!closed && result?.render !== false) tui.requestRender();
        return result ?? { handled: true, render: false };
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 }, anchor: "center" } });
}

/** Long roster summaries must not push confirmation choices below the viewport. */
export async function confirmOption(ui, title, message) {
  return (await selectOption(ui, `${title}\n${message}`, ["Yes", "No"])) === "Yes";
}
