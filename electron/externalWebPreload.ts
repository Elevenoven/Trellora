import { ipcRenderer } from 'electron';

type ExternalWebNavigationAction = 'back' | 'forward' | 'reload' | 'close';

interface ExternalWebNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
}

let navigationState: ExternalWebNavigationState = {
  canGoBack: false,
  canGoForward: false,
};

let backButton: HTMLButtonElement | null = null;
let forwardButton: HTMLButtonElement | null = null;

function updateNavigationButtons(): void {
  if (backButton) backButton.disabled = !navigationState.canGoBack;
  if (forwardButton) forwardButton.disabled = !navigationState.canGoForward;
}

function requestNavigation(action: ExternalWebNavigationAction): void {
  ipcRenderer.send('external-web-navigation', action);
}

function createToolbarButton(action: ExternalWebNavigationAction, label: string, glyph: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'menghan-external-web-toolbar-button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = glyph;
  button.addEventListener('click', () => requestNavigation(action));
  return button;
}

function mountExternalWebToolbar(): void {
  if (document.getElementById('menghan-external-web-toolbar-host')) return;

  const host = document.createElement('div');
  host.id = 'menghan-external-web-toolbar-host';
  host.setAttribute('aria-label', '网页导航');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    #toolbar {
      position: fixed;
      z-index: 2147483647;
      top: 0;
      left: 0;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      width: 100%;
      height: 46px;
      padding: 0 12px;
      border-bottom: 1px solid #c9d2dd;
      background: rgba(248, 250, 252, 0.98);
      box-shadow: 0 1px 6px rgba(15, 23, 42, 0.14);
      font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
    }
    .menghan-external-web-toolbar-button {
      width: 34px;
      height: 34px;
      margin: 0 2px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: #24364b;
      cursor: pointer;
      font-family: inherit;
      font-size: 21px;
      line-height: 1;
    }
    .menghan-external-web-toolbar-button:hover:not(:disabled) { background: #e2e8f0; }
    .menghan-external-web-toolbar-button:focus-visible { outline: 2px solid #3182ce; outline-offset: 1px; }
    .menghan-external-web-toolbar-button:disabled { color: #a6b0bd; cursor: default; }
    .close { color: #b42318; }
    .close:hover:not(:disabled) { background: #fee4e2; }
  `;

  const toolbar = document.createElement('div');
  toolbar.id = 'toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '网页导航');
  backButton = createToolbarButton('back', '后退', '←');
  forwardButton = createToolbarButton('forward', '前进', '→');
  const reloadButton = createToolbarButton('reload', '刷新', '⟳');
  const closeButton = createToolbarButton('close', '关闭网页并返回笔记', '×');
  closeButton.classList.add('close');

  toolbar.append(backButton, forwardButton, reloadButton, closeButton);
  shadow.append(style, toolbar);
  document.documentElement.append(host);
  document.documentElement.style.setProperty('scroll-padding-top', '46px');
  document.body?.style.setProperty('padding-top', '46px', 'important');
  updateNavigationButtons();
}

ipcRenderer.on('external-web-navigation-state', (_event, nextState: ExternalWebNavigationState) => {
  navigationState = {
    canGoBack: nextState?.canGoBack === true,
    canGoForward: nextState?.canGoForward === true,
  };
  updateNavigationButtons();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountExternalWebToolbar, { once: true });
} else {
  mountExternalWebToolbar();
}
