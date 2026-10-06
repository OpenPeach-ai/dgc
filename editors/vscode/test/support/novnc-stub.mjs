// Tests run the computer tab in jsdom, which has no canvas: they inject a fake viewer instead
// (globalThis.__dgcTestRFB). This stub only stands in for the module at bundle time.
export default class RFB { constructor() { throw new Error('noVNC is not available in tests'); } }
