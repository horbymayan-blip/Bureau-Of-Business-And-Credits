declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path?: string);
    exec(sql: string): void;
    prepare(sql: string): any;
    close(): void;
    open(): void;
  }
}
