/**
 * 화면·창 캡처. Electron desktopCapturer 의 썸네일을 화면 해상도로 요청해 PNG 로 저장한다.
 *
 * - 저장 위치: 사진 폴더 아래 'VideoSlim 캡처' (이름이 겹치면 번호). 기존 파일은 덮어쓰지 않는다.
 * - 캡처 전 앱 창을 최소화할 수 있다 (앱 자신이 찍히지 않도록). 캡처 뒤 창을 복원한다.
 * - 네트워크 전송 없음. 캡처 파일은 사용자의 폴더에만 남는다.
 */
import fs from 'node:fs';
import { desktopCapturer, screen, type NativeImage } from 'electron';
import type { CaptureResult, CaptureSource } from '../../../shared/types/domain';
import { AppError } from '../AppError';
import { resolveFinalPath } from '../FileFinalizeService';
import type { Logger } from '../../platform/logger';

export interface CaptureDeps {
  /** 캡처 파일을 둘 폴더 (예: <Pictures>/VideoSlim 캡처) */
  dir: string;
  logger: Logger;
  /** 앱 창 숨기기·복원 (창이 없으면 아무것도 하지 않는다) */
  hideApp: () => void;
  showApp: () => void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const LIST_THUMB = { width: 320, height: 200 };

export class ScreenCaptureService {
  constructor(private readonly deps: CaptureDeps) {}

  async sources(): Promise<CaptureSource[]> {
    const list = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: LIST_THUMB,
      fetchWindowIcons: false,
    });
    return list
      .filter((s) => !s.thumbnail.isEmpty())
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: s.thumbnail.toDataURL(),
      }));
  }

  async take(sourceId: string, delaySec: number, hideApp: boolean): Promise<CaptureResult> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    if (hideApp) this.deps.hideApp();
    try {
      // 창을 숨겼으면 화면이 갱신될 시간을 조금 준다
      const waitMs = Math.max(delaySec * 1000, hideApp ? 600 : 0);
      if (waitMs > 0) await sleep(waitMs);
      const image = await this.grab(sourceId);
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) {
        throw new AppError('CAPTURE_FAILED', '빈 이미지가 돌아왔습니다');
      }
      fs.mkdirSync(this.deps.dir, { recursive: true });
      const at = (this.deps.now ?? (() => new Date()))();
      const base = `캡처 ${stamp(at)}`;
      const finalPath = resolveFinalPath(this.deps.dir, base, 'png', '');
      // 캡처는 메모리에서 바로 쓰므로 임시 파일 단계가 없다. resolveFinalPath 가 기존 파일과 겹치지 않는 이름을 고른다.
      fs.writeFileSync(finalPath, image.toPNG(), { flag: 'wx' });
      const sizeBytes = fs.statSync(finalPath).size;
      this.deps.logger.info('screen captured', { sourceId, finalPath, ...size });
      return { path: finalPath, width: size.width, height: size.height, sizeBytes };
    } finally {
      if (hideApp) this.deps.showApp();
    }
  }

  /** 화면 전체 해상도(배율 반영)로 썸네일을 요청해 캡처 이미지로 쓴다 */
  private async grab(sourceId: string): Promise<NativeImage> {
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => Math.ceil(d.size.width * d.scaleFactor)), 1);
    const maxH = Math.max(...displays.map((d) => Math.ceil(d.size.height * d.scaleFactor)), 1);
    const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
    const list = await desktopCapturer.getSources({
      types: [kind],
      thumbnailSize: { width: maxW, height: maxH },
      fetchWindowIcons: false,
    });
    const src = list.find((s) => s.id === sourceId);
    if (!src)
      throw new AppError('CAPTURE_FAILED', '캡처 대상을 찾을 수 없습니다 (창이 닫혔을 수 있음)');
    return src.thumbnail;
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
