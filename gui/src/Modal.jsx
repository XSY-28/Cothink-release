import React, { useEffect, useRef } from "react";
export function Modal({ title, onClose, children, wide = false }) {
  const dialog = useRef(null),
    close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement,
      node = dialog.current;
    const focusables = () =>
      [
        ...node.querySelectorAll(
          'button,input:not([type="hidden"]),select,textarea,a[href],summary,[tabindex="0"]',
        ),
      ].filter((n) => {
        if (
          n.matches(":disabled") ||
          n.closest("[hidden],[inert]") ||
          (n.hasAttribute("tabindex") && n.tabIndex < 0)
        )
          return false;
        // Fieldset disabled state is inherited, except through its first legend.
        for (
          let fieldset = n.matches("button,input,select,textarea")
            ? n.closest("fieldset[disabled]")
            : null;
          fieldset;
          fieldset = fieldset.parentElement?.closest("fieldset[disabled]")
        ) {
          const legend = [...fieldset.children].find(
            (child) => child.tagName === "LEGEND",
          );
          if (!legend?.contains(n)) return false;
        }
        const visibility = window.getComputedStyle(n).visibility;
        return (
          n.getClientRects().length > 0 &&
          visibility !== "hidden" &&
          visibility !== "collapse"
        );
      });
    (focusables()[0] || node).focus();
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      }
      if (e.key === "Tab") {
        const items = focusables(),
          first = items[0],
          last = items.at(-1);
        if (!items.includes(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
          if (!items.length) node.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    node.addEventListener("keydown", key);
    return () => {
      node.removeEventListener("keydown", key);
      if (previous?.isConnected && previous.getClientRects().length)
        previous.focus();
      else document.querySelector(".nav-toggle")?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header className="panel-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={`关闭${title}`}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
