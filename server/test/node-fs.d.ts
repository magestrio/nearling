// `vitest.config.ts` runs in Node and reads two files of the repo (the contract's numbers and the
// character presets). The server's tsconfig carries the Workers types, not Node's; this is the one
// function the config uses, declared here instead of adding `@types/node`.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
