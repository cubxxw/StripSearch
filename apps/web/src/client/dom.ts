export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

export interface MakeOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null>;
  children?: (Node | null | undefined)[];
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
  style?: Partial<CSSStyleDeclaration>;
}

export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: MakeOptions = {}
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    if (handler) element.addEventListener(event, handler as EventListener);
  }
  for (const child of options.children ?? []) {
    if (child) element.appendChild(child);
  }
  if (options.style) Object.assign(element.style, options.style);
  return element;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function setText(node: Element, value: string): void {
  node.textContent = value;
}

export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '时间未标注';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${formatDate(value)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
