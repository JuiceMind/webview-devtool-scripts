eruda.init({
  tool: ['console', 'elements', 'network', 'resources', 'dom'],
  defaults: {
    displaySize: 20,
    theme: 'Atom One Dark',
  },
});
const devtools = eruda.get();
// Hide the floating toggle button, we have one in the workspace
eruda.get('entryBtn').hide();

window.addEventListener('message', (event) => {
  if (typeof event.data !== 'object' || !('type' in event.data)) {
    return;
  }

  if (event.data.type === 'toggleDevtools') {
    devtools.toggle();
  }
});

let unseenErrorCount = 0;
let isDevtoolsShown = false;
// Will be unset/false if there was no visible tool
const lastToolStorageKey = 'ERUDA_LAST_TOOL';
let lastTool = 'console';
devtools.on('showTool', (toolName) => {
  if (toolName === 'console') {
    unseenErrorCount = 0;
  }

  lastTool = toolName;

  try {
    localStorage.setItem(lastToolStorageKey, lastTool);
  } catch { }
});
devtools.on('hide', () => {
  isDevtoolsShown = false;
  try {
    localStorage.removeItem(lastToolStorageKey);
  } catch { }
});
devtools.on('show', () => {
  isDevtoolsShown = true;

  unseenErrorCount = 0;

  try {
    localStorage.setItem(lastToolStorageKey, lastTool);
  } catch { }
});
try {
  const storedLastTool = localStorage.getItem(lastToolStorageKey);
  if (storedLastTool) {
    lastTool = storedLastTool;
    isDevtoolsShown = true;
    // First show the devtools
    eruda.show();
    // Then explicitly set the tool and force a UI update
    setTimeout(() => {
      devtools.showTool(lastTool);
      // Force the UI to update to match the selected tool
      devtools.get(lastTool).show();
    }, 0);
  }
} catch { }

function onError() {
  if (isDevtoolsShown) {
    return;
  }

  unseenErrorCount++;
  parent.postMessage({
    type: 'show-badge',
    count: unseenErrorCount,
  });
}

function forwardLog(method, ...args) {
  parent.postMessage({
    type: 'forward-log',
    method,
    // TODO a more robust serializer
    message: args
      .map((a) => {
        try {
          return JSON.stringify(a, null, 0);
        } catch {
          return `Devtools error: console message could not be stringified`;
        }
      })
      .join(' '),
  });
}



window.addEventListener('error', (err) => {
  onError();
  forwardLog('error', {
    message: err.message,
    stack: err.stack,
    type: err.type,
  });
});
window.addEventListener('unhandledrejection', (err) => {
  onError();
  forwardLog('unhandledrejection', {
    message: err.message,
    stack: err.stack,
    type: err.type,
  });
});

const eConsole = eruda.get('console');
eConsole.on('error', onError);

[
  'log',
  'error',
  'info',
  'warn',
  'dir',
  'time',
  'timeLog',
  'timeEnd',
  'clear',
  'table',
  'assert',
  'count',
  'countReset',
  'debug',
  'group',
  'groupCollapsed',
  'groupEnd',
].map((method) => {
  eConsole.on(method, (...args) => forwardLog(method, args));
});

// Add URL tracking
function sendFullUrl() {
  parent.postMessage({
    type: 'FULL_URL',
    url: window.location.href,
    path: window.location.pathname
  }, '*');
}

window.addEventListener('load', sendFullUrl);
window.addEventListener('popstate', sendFullUrl);
