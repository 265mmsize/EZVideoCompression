/**
 * Electron 메인 프로세스 진입점.
 *
 * 책임: 창 생성과 보안 설정, 단일 인스턴스 보장, 서비스 조립, IPC 등록, 종료 시 정리.
 * 영상 처리 로직은 여기에 두지 않는다 (src/main/services 에서 Electron 없이 테스트한다).
 */
import path from 'node:path';
import { app, BrowserWindow, dialog, session, shell, type FileFilter } from 'electron';
import { createServices, type AppServices } from './container';
import { registerIpc, type DialogPort } from './ipc/registerIpc';
import { CHANNEL_NAMES, type EventChannel } from '../shared/contracts/ipc';

const isDev = !app.isPackaged;
let services: AppServices | null = null;
let mainWindow: BrowserWindow | null = null;

const VIDEO_FILTER: FileFilter = {
  name: '영상 파일',
  extensions: [
    'mp4',
    'm4v',
    'mov',
    'mkv',
    'avi',
    'webm',
    'wmv',
    'flv',
    'mpg',
    'mpeg',
    'ts',
    'mts',
    'm2ts',
    '3gp',
    'ogv',
  ],
};

// 단일 인스턴스: 두 번째 실행은 기존 창을 앞으로 가져오고 종료한다 (DB 동시 접근 방지)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void app.whenReady().then(() => bootstrap());
}

function bundledBinDir(): string | null {
  // 패키징 후: resources/binaries/<platform>-<arch>, 개발 중: 프로젝트의 resources/binaries/<platform>-<arch>
  const sub = `${process.platform}-${process.arch}`;
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  return path.join(base, 'binaries', sub);
}

function emit(channel: EventChannel, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function bootstrap(): void {
  services = createServices({
    userDataDir: app.getPath('userData'),
    bundledBinDir: bundledBinDir(),
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
    emit,
    echoLogs: isDev,
  });

  const dialogs: DialogPort = {
    pickFiles: async () => {
      const res = await dialog.showOpenDialog(
        mainWindow ?? (undefined as unknown as BrowserWindow),
        {
          title: '영상 파일 선택',
          properties: ['openFile', 'multiSelections'],
          filters: [VIDEO_FILTER, { name: '모든 파일', extensions: ['*'] }],
        },
      );
      return res.canceled ? null : res.filePaths;
    },
    pickFolder: async () => {
      const res = await dialog.showOpenDialog(
        mainWindow ?? (undefined as unknown as BrowserWindow),
        {
          title: '영상 폴더 선택',
          properties: ['openDirectory'],
        },
      );
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    saveLogFile: async (defaultName) => {
      const res = await dialog.showSaveDialog({
        title: '지원용 로그 내보내기',
        defaultPath: defaultName,
        filters: [{ name: '텍스트', extensions: ['txt'] }],
      });
      return res.canceled ? null : res.filePath;
    },
  };

  registerIpc({
    services,
    dialogs,
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
  });

  // 이전 실행이 끝나지 않은 작업을 중단 상태로 바꾸고, 앱이 만든 임시 파일을 정리한다
  const recovered = services.queue.recoverInterrupted();
  services.logger.info('startup', { recoveredJobs: recovered, version: app.getVersion() });
  void services.refreshTools();

  installSecurityPolicy();
  createWindow();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'VideoSlim Desktop',
    backgroundColor: '#f8fafc',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 보안 기본값: 격리 컨텍스트, 샌드박스, Node 통합 비활성화
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 외부 탐색과 새 창을 막는다. 열 필요가 있는 외부 주소는 시스템 브라우저로만 연다.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedAppUrl(url)) event.preventDefault();
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** 앱이 로드하는 주소만 허용한다 (파일 URL 또는 개발 서버 주소) */
function isAllowedAppUrl(url: string): boolean {
  if (url.startsWith('file://')) return true;
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return Boolean(dev && url.startsWith(dev));
}

/** 세션 단위 정책: 권한 요청 거부, 외부 리소스 로드 차단(오프라인 원칙) */
function installSecurityPolicy(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok =
      details.url.startsWith('file://') ||
      details.url.startsWith('devtools://') ||
      (process.env['ELECTRON_RENDERER_URL'] !== undefined &&
        details.url.startsWith(process.env['ELECTRON_RENDERER_URL']));
    callback({ cancel: !ok });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && services) createWindow();
});

let closing = false;
app.on('before-quit', (event) => {
  if (closing || !services) return;
  // 실행 중 작업을 정리한 뒤 종료한다
  event.preventDefault();
  closing = true;
  const s = services;
  void s.close().finally(() => {
    services = null;
    app.exit(0);
  });
});

// 채널 목록이 계약과 어긋나지 않도록 개발 중 한 번 확인한다
if (isDev && CHANNEL_NAMES.invoke.length === 0) {
  throw new Error('IPC 채널 계약이 비어 있습니다');
}
