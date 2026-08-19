// The chrome-remote-interface package ships no types; we use it loosely.
// Domain access and event wiring are cast to our own CDPClient shape in cdp.ts.
declare module "chrome-remote-interface" {
  const CDP: any;
  export default CDP;
}
