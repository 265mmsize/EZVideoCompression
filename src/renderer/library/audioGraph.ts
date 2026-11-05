/**
 * 재생 소리 처리: 영상 요소의 소리를 Web Audio 로 받아 10밴드 이퀄라이저를 거치고 출력한다.
 * 요소마다 한 번만 연결할 수 있으므로 요소별로 한 그래프를 만든다. 실패하면 소리는 그대로 나온다.
 */
import { bandParams, EQ_FREQS } from './audioFx';

export class AudioGraph {
  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private analyser: AnalyserNode | null = null;
  private buf: Float32Array<ArrayBuffer> | null = null;
  private failed = false;

  constructor(private readonly el: HTMLMediaElement) {}

  /** 그래프를 만든다. 이미 있으면 그대로, 실패하면 false. 사용자 동작(재생) 안에서 부른다. */
  ensure(): boolean {
    if (this.ctx) return true;
    if (this.failed) return false;
    try {
      const AC = window.AudioContext;
      const ctx = new AC();
      const source = ctx.createMediaElementSource(this.el);
      this.filters = EQ_FREQS.map((f) => {
        const b = ctx.createBiquadFilter();
        const p = bandParams(f, 0);
        b.type = p.type;
        b.frequency.value = p.frequency;
        b.gain.value = p.gain;
        b.Q.value = p.Q;
        return b;
      });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      this.buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      let node: AudioNode = source;
      for (const f of this.filters) {
        node.connect(f);
        node = f;
      }
      node.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** 밴드 값(dB)을 적용한다. 그래프가 없으면 나중에 ensure 뒤에 다시 부른다. */
  setGains(gains: readonly number[]): void {
    this.filters.forEach((b, i) => {
      b.gain.value = gains[i] ?? 0;
    });
  }

  /** 자동재생 정책으로 멈춰 있으면 깨운다 */
  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** 지금 나오는 소리의 크기 (0~1 근사 RMS) */
  level(): number {
    if (!this.analyser || !this.buf) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (const v of this.buf) s += v * v;
    return Math.sqrt(s / this.buf.length);
  }

  dispose(): void {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.filters = [];
    this.analyser = null;
  }
}

const graphs = new WeakMap<HTMLMediaElement, AudioGraph>();

/** 요소의 소리 그래프 (없으면 만든다) */
export function graphFor(el: HTMLMediaElement): AudioGraph {
  let g = graphs.get(el);
  if (!g) {
    g = new AudioGraph(el);
    graphs.set(el, g);
  }
  return g;
}
