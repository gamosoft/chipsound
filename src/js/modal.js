// Shared modal primitive. Every popup dialog (help, library, …) is built
// with createModal() so they share one overlay/card shell, one set of
// theme-aware styles (.modal-* in style.css) and one behaviour:
//
//   - lazy build on first open, content supplied by `build(body, modal)`
//   - Esc and backdrop click close; only one modal is open at a time
//   - focus moves into the dialog on open, is trapped inside (Tab cycles)
//     and returns to the previously focused element on close
//   - aria: role=dialog, aria-modal, labelled by the title
//
// createModal({ id, title, className, width, build, onOpen, onClose })
//   → { open(), close(), toggle(), isOpen(), el, body }

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current = null;       // the open modal, if any
let listenerInstalled = false;

function installGlobalListener() {
    if (listenerInstalled) return;
    listenerInstalled = true;
    document.addEventListener('keydown', e => {
        if (!current) return;
        if (e.code === 'Escape') {
            e.preventDefault();
            current.close();
            return;
        }
        if (e.key === 'Tab') trapTab(e, current.el);
    });
}

function trapTab(e, root) {
    const items = [...root.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
}

export function createModal({ id, title, className = '', width = null, build, onOpen, onClose }) {
    let el = null, body = null, titleEl = null;
    let restoreFocus = null;

    const modal = {
        get el() { return el; },
        get body() { return body; },
        isOpen: () => current === modal,
        setTitle(html) { if (titleEl) titleEl.innerHTML = html; },
        open() {
            if (!el) buildShell();
            if (current && current !== modal) current.close();
            restoreFocus = document.activeElement;
            el.classList.add('visible');
            current = modal;
            onOpen?.(modal);
            // Prefer the first control in the body; fall back to the close button.
            const target = body.querySelector(FOCUSABLE) || el.querySelector('.modal-close');
            target?.focus({ preventScroll: true });
        },
        close() {
            if (!el || current !== modal) return;
            el.classList.remove('visible');
            current = null;
            onClose?.(modal);
            if (restoreFocus && document.contains(restoreFocus)) restoreFocus.focus({ preventScroll: true });
            restoreFocus = null;
        },
        toggle() { if (modal.isOpen()) modal.close(); else modal.open(); },
    };

    function buildShell() {
        installGlobalListener();
        el = document.createElement('div');
        el.id = id;
        el.className = `modal-overlay ${className}`.trim();
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', `${id}-title`);
        if (width) el.style.setProperty('--modal-width', width);
        el.innerHTML = `
            <div class="modal-card">
                <h2 class="modal-title"><span id="${id}-title"></span>
                    <button type="button" class="modal-close" aria-label="Close (Esc)">×</button></h2>
                <div class="modal-body"></div>
            </div>`;
        titleEl = el.querySelector(`#${id}-title`);
        titleEl.innerHTML = title;
        body = el.querySelector('.modal-body');
        el.addEventListener('click', e => { if (e.target === el) modal.close(); });
        el.querySelector('.modal-close').addEventListener('click', modal.close);
        document.body.appendChild(el);
        build?.(body, modal);
    }

    return modal;
}

export function closeAnyModal() { current?.close(); }
export function isAnyModalOpen() { return current !== null; }
