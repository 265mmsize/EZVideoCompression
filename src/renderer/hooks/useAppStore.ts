import { useSyncExternalStore } from 'react';
import { getState, subscribeStore, type AppState } from '../stores/appStore';

/** 저장소 전체를 구독한다. 화면이 작으므로 선택자 없이 단순하게 쓴다. */
export function useAppStore(): AppState {
  return useSyncExternalStore(subscribeStore, getState, getState);
}
