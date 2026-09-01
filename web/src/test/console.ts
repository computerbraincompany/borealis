const REACT_ACT_WARNING = /not wrapped in act|not configured to support act|act scope.*not awaited/i;

/** Turn React's asynchronous ownership warnings into deterministic test failures. */
export function failOnReactActWarning(args: readonly unknown[]): void {
  const message = args.map((value) => (typeof value === "string" ? value : "")).join(" ");
  if (REACT_ACT_WARNING.test(message)) throw new Error(`unexpected React act warning: ${message.slice(0, 500)}`);
}
