export function cancelled(): DOMException {
  return new DOMException("Audio operation cancelled.", "AbortError");
}

/** Observe late rejections too: native audio decoding has no AbortSignal API. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(cancelled());
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}
