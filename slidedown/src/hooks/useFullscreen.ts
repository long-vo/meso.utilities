import { useCallback, useEffect, useState, type RefObject } from 'react';

interface FullscreenApi {
  isFullscreen: boolean;
  toggle: () => void;
}

/** Fullscreen state + toggle bound to a target element. */
export function useFullscreen(target: RefObject<HTMLElement>): FullscreenApi {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = (): void =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggle = useCallback(() => {
    if (!document.fullscreenElement) {
      target.current?.requestFullscreen?.().catch(() => undefined);
    } else {
      document.exitFullscreen?.().catch(() => undefined);
    }
  }, [target]);

  return { isFullscreen, toggle };
}
