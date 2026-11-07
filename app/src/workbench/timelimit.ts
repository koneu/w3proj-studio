/** `promise`, or a rejection after `ms`: for questions to the disk or network that may never be
 *  answered (an offline share), when nothing may wait for them. */
export function timeLimit<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}
