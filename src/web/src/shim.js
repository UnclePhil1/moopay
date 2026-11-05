import { Buffer } from "buffer/";
globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, version: "", versions: {}, browser: true };
