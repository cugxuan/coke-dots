import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

type Position = { x: number; y: number };
const EDGE_GAP = 12;

export function useCallCardPosition(floating: boolean) {
  const cardRef = useRef<HTMLElement | null>(null);
  const positionRef = useRef<Position | null>(null);
  const dragRef = useRef<{ pointerId: number; start: Position; origin: Position; handle: HTMLDivElement } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [dragging, setDragging] = useState(false);

  function moveTo(next: Position) {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + EDGE_GAP;
    const top = (viewport?.offsetTop || 0) + EDGE_GAP;
    const clamped = {
      x: Math.max(left, Math.min(next.x, left + (viewport?.width ?? window.innerWidth) - rect.width - EDGE_GAP * 2)),
      y: Math.max(top, Math.min(next.y, top + (viewport?.height ?? window.innerHeight) - rect.height - EDGE_GAP * 2)),
    };
    if (positionRef.current?.x === clamped.x && positionRef.current?.y === clamped.y) return;
    positionRef.current = clamped;
    setPosition(clamped);
  }

  function releaseDrag() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  }

  useLayoutEffect(() => {
    setDragging(false);
    if (!floating) return;
    const card = cardRef.current;
    if (!card) return;
    const keepVisible = () => {
      const rect = card.getBoundingClientRect();
      // Keep the default CSS anchor until the card is moved or would go offscreen.
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      if (positionRef.current || rect.left < left + EDGE_GAP || rect.top < top + EDGE_GAP
        || rect.right > left + (viewport?.width ?? window.innerWidth) - EDGE_GAP
        || rect.bottom > top + (viewport?.height ?? window.innerHeight) - EDGE_GAP) {
        moveTo(positionRef.current ?? { x: rect.left, y: rect.top });
      }
    };
    keepVisible();
    const observer = new ResizeObserver(keepVisible);
    observer.observe(card);
    window.addEventListener('resize', keepVisible);
    window.visualViewport?.addEventListener('resize', keepVisible);
    window.visualViewport?.addEventListener('scroll', keepVisible);
    return () => {
      releaseDrag();
      observer.disconnect();
      window.removeEventListener('resize', keepVisible);
      window.visualViewport?.removeEventListener('resize', keepVisible);
      window.visualViewport?.removeEventListener('scroll', keepVisible);
    };
  }, [floating]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!floating || !event.isPrimary || event.button !== 0 || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { x: rect.left, y: rect.top }, handle: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) < 4) return;
    setDragging(true);
    moveTo({ x: drag.origin.x + dx, y: drag.origin.y + dy });
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    releaseDrag();
    setDragging(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!floating || !cardRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = cardRef.current.getBoundingClientRect();
    const step = event.shiftKey ? 40 : 10;
    moveTo({ x: rect.left + direction[0] * step, y: rect.top + direction[1] * step });
  };

  return {
    cardRef,
    dragging,
    style: floating && position ? { left: position.x, top: position.y, right: 'auto' } as CSSProperties : undefined,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onLostPointerCapture: onPointerEnd, onKeyDown },
  };
}
