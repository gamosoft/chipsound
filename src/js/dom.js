export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// el('div', { class: 'foo' }, 'hello')
export function el(tag, attrs = {}, content) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === false || value == null) continue;
        if (name === 'class') node.className = value;
        else if (name === 'dataset') Object.assign(node.dataset, value);
        else if (name.startsWith('on') && typeof value === 'function') {
            node.addEventListener(name.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(name, value === true ? '' : value);
        }
    }
    if (content !== undefined && content !== null) {
        if (Array.isArray(content)) {
            content.forEach(c => node.append(c));
        } else if (content instanceof Node) {
            node.append(content);
        } else {
            node.innerHTML = String(content);
        }
    }
    return node;
}

export function setText(selectorOrNode, text) {
    const node = typeof selectorOrNode === 'string' ? $(selectorOrNode) : selectorOrNode;
    if (!node) return;
    node.textContent = text;
    if (node.id === 'fileName' || node.id === 'songName') {
        node.title = text && text !== '\u00a0' ? text : '';
    }
}

export function show(node, visible = true) {
    if (!node) return;
    node.style.display = visible ? '' : 'none';
}

export function setEnabled(node, enabled) {
    if (!node) return;
    node.disabled = !enabled;
    node.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

export function on(target, event, selectorOrHandler, maybeHandler) {
    if (typeof selectorOrHandler === 'function') {
        target.addEventListener(event, selectorOrHandler);
        return;
    }
    const selector = selectorOrHandler;
    const handler = maybeHandler;
    target.addEventListener(event, e => {
        const match = e.target.closest(selector);
        if (match && target.contains(match)) handler.call(match, e);
    });
}

export function debounce(fn, wait = 100) {
    let timer = null;
    return function debounced(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

export function isTypingTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
