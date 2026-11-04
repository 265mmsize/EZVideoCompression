/**
 * 타임라인 위 오디오 파형. 파일마다 한 번만 메인에 요청하고 결과를 나눠 쓴다.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { libraryApi } from '../library/libraryActions';
import { waveformPath } from './waveformPath';

interface Wave {
  peaksPerSec: number;
  peaks: number[];
}

const cache = new Map<string, Promise<Wave | null>>();

function loadWave(path: string): Promise<Wave | null> {
  let p = cache.get(path);
  if (!p) {
    p = libraryApi.editWaveform(path);
    cache.set(path, p);
  }
  return p;
}

/** 원본 구간 [fromSec, toSec] 의 파형을 width×height 상자에 그린다 */
export function Waveform({
  path,
  fromSec,
  toSec,
  width,
  height,
  className = '',
}: {
  path: string;
  fromSec: number;
  toSec: number;
  width: number;
  height: number;
  className?: string;
}): ReactNode {
  const [wave, setWave] = useState<Wave | null>(null);
  useEffect(() => {
    const live = { on: true };
    void loadWave(path).then((w) => {
      if (live.on) setWave(w);
    });
    return () => {
      live.on = false;
    };
  }, [path]);
  if (!wave || wave.peaks.length === 0) return null;
  const d = waveformPath(wave.peaks, wave.peaksPerSec, fromSec, toSec, width, height);
  return (
    <svg
      aria-hidden
      data-testid="waveform"
      width={width}
      height={height}
      className={`pointer-events-none absolute left-0 ${className}`}
    >
      <path d={d} stroke="currentColor" strokeWidth={1} opacity={0.55} />
    </svg>
  );
}
