declare module "core-js-pure/actual/structured-clone" {
  const structuredClonePolyfill: typeof globalThis.structuredClone;
  export default structuredClonePolyfill;
}
