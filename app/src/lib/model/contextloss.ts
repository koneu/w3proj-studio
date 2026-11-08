/** A WebGL canvas losing its context (a GPU reset, a driver update or hiccup, too many contexts in
 *  the page) and being given it back. Without a handler a lost context stays lost: the view is a
 *  dead picture and every later GL call does nothing. */
export interface ContextLossWatch {
  /** True from a loss until the context is restored. */
  readonly lost: boolean;
  /** Stops listening. A renderer's dispose() loses its context on purpose: stop the watch first. */
  dispose(): void;
}

/** Calls `lost` when the canvas's context is lost and `restored` when it is given back. Each loss
 *  is accepted with preventDefault(), which is what lets the browser restore the context at all. */
export function watchContextLoss(canvas: EventTarget, on: { lost(): void; restored(): void }): ContextLossWatch {
  let lost = false, live = true;
  const onLost = (e: Event) => {
    e.preventDefault();
    if (!live || lost) return;
    lost = true;
    on.lost();
  };
  const onRestored = () => {
    if (!live || !lost) return;
    lost = false;
    on.restored();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return {
    get lost() { return lost; },
    dispose() {
      live = false;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    },
  };
}
