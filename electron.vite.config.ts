import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// electron-vite 기본 규약을 따른다.
//   main:     src/main/index.ts
//   preload:  src/preload/index.ts
//   renderer: src/renderer/index.html
// 외부 패키지(node:* 내장 모듈 포함)는 번들하지 않고 런타임에서 require 한다.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // file:// 로 여는 Electron 창에서 자산을 찾도록 상대 경로를 쓴다
    base: './',
    plugins: [react(), tailwindcss()],
  },
});
